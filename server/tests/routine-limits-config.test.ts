import { expect, test } from "bun:test";
import { MAX_TIMER_MS, wholeNumberEnv } from "../src/config";
import { createRoutineResearchBudget } from "../src/routines/research-budget";
import type { GrantedTool } from "../src/plugins/tools";
import { z } from "zod";

/**
 * `Number("8m")` is `NaN`, and `NaN` is not a smaller limit: it is no limit and no deadline. These
 * two settings were coerced, so a typo in the unit ended every routine turn on its first tick and
 * removed the browser-call budget at once.
 */
test("a malformed routine limit is refused, naming the setting", () => {
  for (const raw of ["8m", "480_000", "abc", "0", "-1", "1.5", "1e3ms"]) {
    expect(() =>
      wholeNumberEnv(
        { ROUTINE_TURN_TIMEOUT_MS: raw },
        "ROUTINE_TURN_TIMEOUT_MS",
      ),
    ).toThrow("ROUTINE_TURN_TIMEOUT_MS must be a whole number between 1 and");
  }
});

/**
 * A delay past 2^31-1 does not become a long one: it overflows and Node falls back to 1ms, which is
 * `NaN` wearing a plausible number. The deployment that asked for the longest possible turn would
 * have had every turn stopped immediately instead.
 */
test("a delay a timer cannot hold is refused at the boundary, not silently clamped", () => {
  const bound = MAX_TIMER_MS - 5_000;
  expect(
    wholeNumberEnv(
      { ROUTINE_TURN_TIMEOUT_MS: String(bound) },
      "ROUTINE_TURN_TIMEOUT_MS",
      bound,
    ),
  ).toBe(bound);
  for (const raw of [
    String(bound + 1),
    String(MAX_TIMER_MS),
    "9007199254740993",
  ]) {
    expect(() =>
      wholeNumberEnv(
        { ROUTINE_TURN_TIMEOUT_MS: raw },
        "ROUTINE_TURN_TIMEOUT_MS",
        bound,
      ),
    ).toThrow(
      `ROUTINE_TURN_TIMEOUT_MS must be a whole number between 1 and ${bound}`,
    );
  }
  // Proof of what the bound is for: past it, the timer is immediate rather than long.
  const overflowed = Date.now();
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(Date.now() - overflowed).toBeLessThan(1_000);
      resolve();
    }, MAX_TIMER_MS + 1);
  });
});

/** A count is not a delay; only the setting that feeds a timer carries the timer's bound. */
test("a call cap is bounded by what a number can be, not by what a timer can hold", () => {
  expect(
    wholeNumberEnv(
      { ROUTINE_RESEARCH_MAX_CALLS: String(MAX_TIMER_MS + 1) },
      "ROUTINE_RESEARCH_MAX_CALLS",
    ),
  ).toBe(MAX_TIMER_MS + 1);
  expect(() =>
    wholeNumberEnv(
      { ROUTINE_RESEARCH_MAX_CALLS: "9007199254740993" },
      "ROUTINE_RESEARCH_MAX_CALLS",
    ),
  ).toThrow("must be a whole number between 1 and 9007199254740991");
});

test("an absent or blank setting leaves the default in place", () => {
  expect(wholeNumberEnv({}, "ROUTINE_RESEARCH_MAX_CALLS")).toBeUndefined();
  expect(
    wholeNumberEnv(
      { ROUTINE_RESEARCH_MAX_CALLS: "   " },
      "ROUTINE_RESEARCH_MAX_CALLS",
    ),
  ).toBeUndefined();
  expect(
    wholeNumberEnv(
      { ROUTINE_TURN_TIMEOUT_MS: " 480000 " },
      "ROUTINE_TURN_TIMEOUT_MS",
    ),
  ).toBe(480000);
  expect(
    wholeNumberEnv(
      { ROUTINE_RESEARCH_MAX_CALLS: "30" },
      "ROUTINE_RESEARCH_MAX_CALLS",
    ),
  ).toBe(30);
});

test("a research budget with an unusable call cap still ends, rather than running unbounded", async () => {
  const browser = (): GrantedTool => ({
    name: "computer_read",
    ref: "computer/computer_read",
    description: "Read the current page.",
    parameters: z.object({}).catchall(z.unknown()),
    execute: async () =>
      JSON.stringify({ ok: true, url: "https://example.test/a", text: "x" }),
  });
  // The default stands in for the value the operator failed to supply; nothing becomes NaN.
  const budget = createRoutineResearchBudget(300_000, () => 0, undefined);
  const [wrapped] = budget.wrap([browser()]);
  for (let i = 0; i < 30; i += 1) {
    expect(await wrapped!.execute({})).not.toContain(
      "research budget has ended",
    );
  }
  const refused = await wrapped!.execute({});
  expect(refused).toContain("Refused.");
  expect(refused).toContain("research budget has ended");
  expect(refused).not.toContain("NaN");
});
