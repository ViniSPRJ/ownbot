import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { handoffQueueReadiness } from "../src/operations/store";

// Read-only PostgreSQL probe: the CTE shadows the real queue; no fixture writes or migrations.
test.skipIf(!process.env.OPERATIONS_READONLY_TEST_DATABASE_URL)(
  "queue health distinguishes backlog, exhausted retries, active leases and unrelated/completed work",
  async () => {
    const db = createDatabase(process.env.OPERATIONS_READONLY_TEST_DATABASE_URL!, { max: 1 });
    try {
      await db.$client.unsafe("BEGIN READ ONLY");
      for (const fixture of [
        { name: "fresh forward", kind: "bot.message", age: 1, attempts: 0, lease: null, done: false, healthy: true },
        { name: "unclaimed backlog", kind: "bot.message", age: 11, attempts: 0, lease: null, done: false, healthy: false },
        { name: "expired lease backlog", kind: "bot.message", age: 11, attempts: 1, lease: -1, done: false, healthy: false },
        { name: "exhausted return", kind: "bot.message", age: 1, attempts: 5, lease: null, done: false, healthy: false },
        { name: "active final attempt", kind: "bot.message", age: 11, attempts: 5, lease: 1, done: false, healthy: true },
        { name: "completed failure notice", kind: "bot.message", age: 30, attempts: 5, lease: null, done: true, healthy: true },
        { name: "future work", kind: "bot.message", age: -10, attempts: 0, lease: null, done: false, healthy: true },
        { name: "unrelated queue", kind: "computer.suspend", age: 30, attempts: 5, lease: null, done: false, healthy: true },
      ]) {
        const [result] = await db.execute(sql`
          WITH work_items AS (SELECT ${fixture.kind}::text AS kind,
            now()-${fixture.age}*interval '1 minute' AS run_at,
            ${fixture.attempts}::integer AS attempts,
            ${fixture.lease === null ? sql`NULL::timestamptz` : sql`now()+${fixture.lease}*interval '1 minute'`} AS lease_until,
            ${fixture.done ? sql`now()` : sql`NULL::timestamptz`} AS finished_at)
          SELECT ${handoffQueueReadiness} AS healthy
        `);
        expect({ name: fixture.name, healthy: result?.healthy }).toEqual({ name: fixture.name, healthy: fixture.healthy });
      }
    } finally {
      await db.$client.unsafe("ROLLBACK").catch(() => {});
      await db.$client.close();
    }
  },
);
