import { expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import { createOperationsStore } from "../src/operations/store";

test("a stalled Pi watch degrades health even when routines, history, receipts and handoffs are healthy", async () => {
  const db = {
    execute: async () => [
      {
        scheduler: true,
        notifications: true,
        runs: true,
        handoffs: true,
        piWatches: false,
      },
    ],
  } as unknown as Database;
  const health = await createOperationsStore(db).readiness();
  expect(health.status).toBe("degraded");
  expect(health.checks).toEqual({
    database: true,
    scheduler: true,
    notifications: true,
    history: true,
    runs: true,
    handoffs: true,
    piWatches: false,
  });
});

test("terminal Pi jobs do not keep readiness degraded, and SQL failures stay boolean", async () => {
  const db = {
    execute: async () => [
      {
        scheduler: true,
        notifications: true,
        runs: true,
        handoffs: true,
        piWatches: true,
      },
    ],
  } as unknown as Database;
  expect((await createOperationsStore(db).readiness()).status).toBe("ready");
  db.execute = async () => {
    throw new Error("private database details");
  };
  const unavailable = await createOperationsStore(db).readiness();
  expect(unavailable.status).toBe("degraded");
  expect(unavailable.checks.piWatches).toBe(false);
  expect(unavailable.checks.handoffs).toBe(false);
  expect(JSON.stringify(unavailable)).not.toContain("private database details");
});
