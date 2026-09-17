import { expect, test } from "bun:test";
import { routineAbandonedRunMs } from "../src/routines/timing";
import { createRoutineRunner } from "../src/routines/runner";
test("configured 25 minute turns get a 27 minute recovery/readiness bound", () => {
  expect(routineAbandonedRunMs("1500000")).toBe(27 * 60000);
  for (const v of ["", "NaN", "-1", "Infinity", "300000"])
    expect(routineAbandonedRunMs(v)).toBe(10 * 60000);
});
test("a recovered expired cron occurrence is closed without invoking a turn", async () => {
  let turns = 0;
  const finished: unknown[] = [];
  const runner = createRoutineRunner({
    now: () => new Date("2026-09-17T12:00Z"),
    routineStore: {
      claimRun: async () => true,
      runContext: async () => ({
        routineId: "r",
        scheduledFor: new Date("2026-09-17T11:00Z"),
      }),
      finishRun: async (...args: unknown[]) => {
        finished.push(args);
      },
    } as never,
    channelStore: {} as never,
    runTurn: async () => {
      turns++;
      return {} as never;
    },
  });
  await runner.run("run");
  expect(turns).toBe(0);
  expect(finished).toHaveLength(1);
  expect((finished[0] as string[])[1]).toBe("skipped");
});
