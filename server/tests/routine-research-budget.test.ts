import { expect, test } from "bun:test";
import { z } from "zod";
import type { GrantedTool } from "../src/plugins/tools";
import { createRoutineResearchBudget } from "../src/routines/research-budget";

function tool(name: string, execute: GrantedTool["execute"]): GrantedTool {
  return { name, execute, parameters: z.object({}), ref: `computer/${name}`, description: name };
}

test("research stops before the existing deadline, reserving time for all report sections", async () => {
  let clock = 0, called = 0;
  const budget = createRoutineResearchBudget(480_000, () => clock);
  const [browser] = budget.wrap([tool("computer_navigate", async () => { called++; return '{"ok":true,"text":"read evidence"}'; })]);
  expect(await browser!.execute({ url: "https://example.com" })).toContain("read evidence");
  clock = 390_000;
  expect(await browser!.execute({ url: "https://example.com/second" })).toStartWith("Refused.");
  expect(called).toBe(1);
  expect(budget.guidance()).toContain("90 seconds remain");
  expect(budget.guidance()).toContain("every requested section");
});

test("call cap is shared by all browser tools without blocking result handoff", async () => {
  let calls = 0;
  const tools = createRoutineResearchBudget(480_000, () => 0, 14).wrap([
    tool("computer_navigate", async () => { calls++; return '{"ok":true}'; }),
    tool("computer_read", async () => { calls++; return '{"ok":true}'; }),
    tool("message_bot", async () => "result queued"),
  ]);
  for (let i = 0; i < 14; i++) await tools[i % 2]!.execute({});
  expect(await tools[0]!.execute({})).toStartWith("Refused.");
  expect(calls).toBe(14);
  expect(await tools[2]!.execute({})).toBe("result queued");
});

test("stale click cannot repeat until a successful fresh snapshot", async () => {
  let clicks = 0, snapshotOk = false;
  const [click, snapshot] = createRoutineResearchBudget(480_000, () => 0).wrap([
    tool("computer_click", async () => { clicks++; return '{"ok":false,"staleRefs":true}'; }),
    tool("computer_snapshot", async () => JSON.stringify({ ok: snapshotOk })),
  ]);
  await click!.execute({ ref: "old" });
  expect(await click!.execute({ ref: "old" })).toStartWith("Refused.");
  await snapshot!.execute({});
  expect(await click!.execute({ ref: "old" })).toStartWith("Refused.");
  expect(clicks).toBe(1);
  snapshotOk = true;
  await snapshot!.execute({});
  await click!.execute({ ref: "old" });
  expect(clicks).toBe(2);
});

test("concurrent browser calls serialize and recheck elapsed budget before execution", async () => {
  let clock = 0, calls = 0, release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const [browser] = createRoutineResearchBudget(480_000, () => clock).wrap([
    tool("computer_navigate", async () => { calls++; await blocker; return '{"ok":true}'; }),
  ]);
  const first = browser!.execute({}), second = browser!.execute({});
  await Promise.resolve();
  expect(calls).toBe(1);
  clock = 390_000;
  release();
  await first;
  expect(await second).toStartWith("Refused.");
  expect(calls).toBe(1);
});

test("tool errors preserve refusal and separate routines do not share counters", async () => {
  const original = tool("computer_navigate", async () => { throw new Error("gateway denied"); });
  const [guarded] = createRoutineResearchBudget(480_000, () => 0).wrap([original]);
  await expect(guarded!.execute({})).rejects.toThrow("gateway denied");
  expect(createRoutineResearchBudget(480_000, () => 0).guidance()).toContain("30 browser calls remain");
});
