import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PI_WATCH_KIND, PI_WATCH_MAX_ATTEMPTS } from "../src/agents/pi-watch";
import { createDatabase } from "../src/db/client";
import { piWatchQueueReadiness } from "../src/operations/store";

// Isolated PostgreSQL probe only. Never fall back to DATABASE_URL (that may be the
// deployment database). The CTE shadows work_items; no fixture writes.
const url = process.env.TEST_DATABASE_URL;

test.skipIf(!url)(
  "Pi watch health honours live leases, 24h age, stale run_at and exhausted attempts without treating terminal failure as outage",
  async () => {
    const db = createDatabase(url!, { max: 1 });
    try {
      await db.$client.unsafe("BEGIN READ ONLY");
      for (const fixture of [
        {
          name: "fresh pending",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          healthy: true,
        },
        {
          name: "stale run_at without lease",
          kind: PI_WATCH_KIND,
          runAge: 11,
          createdAge: 11,
          attempts: 0,
          lease: null,
          done: false,
          healthy: false,
        },
        {
          name: "expired lease backlog",
          kind: PI_WATCH_KIND,
          runAge: 11,
          createdAge: 11,
          attempts: 2,
          lease: -1,
          done: false,
          healthy: false,
        },
        {
          name: "exhausted attempts",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: PI_WATCH_MAX_ATTEMPTS,
          lease: null,
          done: false,
          healthy: false,
        },
        {
          name: "live lease even when exhausted and old",
          kind: PI_WATCH_KIND,
          runAge: 30,
          createdAge: 30 * 60,
          attempts: PI_WATCH_MAX_ATTEMPTS,
          lease: 1,
          done: false,
          healthy: true,
        },
        {
          name: "24h age without lease",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 25 * 60,
          attempts: 0,
          lease: null,
          done: false,
          healthy: false,
        },
        {
          name: "24h age with live lease",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 25 * 60,
          attempts: 0,
          lease: 1,
          done: false,
          healthy: true,
        },
        {
          name: "finished failed",
          kind: PI_WATCH_KIND,
          runAge: 30,
          createdAge: 30,
          attempts: 3,
          lease: null,
          done: true,
          state: "failed",
          healthy: true,
        },
        {
          name: "finished access_revoked",
          kind: PI_WATCH_KIND,
          runAge: 30,
          createdAge: 30,
          attempts: 1,
          lease: null,
          done: true,
          state: "access_revoked",
          healthy: true,
        },
        {
          name: "finished unknown",
          kind: PI_WATCH_KIND,
          runAge: 30,
          createdAge: 30,
          attempts: 1,
          lease: null,
          done: true,
          state: "unknown",
          healthy: true,
        },
        {
          name: "finished interrupted",
          kind: PI_WATCH_KIND,
          runAge: 30,
          createdAge: 30,
          attempts: 1,
          lease: null,
          done: true,
          state: "interrupted",
          healthy: true,
        },
        {
          name: "unrelated queue",
          kind: "bot.message",
          runAge: 30,
          createdAge: 30,
          attempts: PI_WATCH_MAX_ATTEMPTS,
          lease: null,
          done: false,
          healthy: true,
        },
        {
          name: "future work",
          kind: PI_WATCH_KIND,
          runAge: -10,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          healthy: true,
        },
        {
          name: "payload createdAt aged",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          payloadCreatedAgeHours: 25,
          healthy: true,
        },
        {
          name: "malformed payload createdAt secret",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          payloadCreatedAt: "secret",
          healthy: true,
        },
        {
          name: "malformed payload createdAt object",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          payloadCreatedObject: true,
          healthy: true,
        },
        {
          name: "malformed payload createdAt huge numeric",
          kind: PI_WATCH_KIND,
          runAge: 1,
          createdAge: 1,
          attempts: 0,
          lease: null,
          done: false,
          payloadCreatedHuge: true,
          healthy: true,
        },
      ]) {
        const payload = fixture.payloadCreatedObject
          ? sql`jsonb_build_object('createdAt', jsonb_build_object('nested', true))`
          : "payloadCreatedHuge" in fixture
            ? sql`'{"createdAt": 1e1000}'::jsonb`
            : "payloadCreatedAt" in fixture
              ? sql`jsonb_build_object('createdAt', ${fixture.payloadCreatedAt}::text)`
              : "payloadCreatedAgeHours" in fixture
                ? sql`jsonb_build_object('createdAt', trunc(extract(epoch from now()-make_interval(hours => ${fixture.payloadCreatedAgeHours})) * 1000))`
                : "state" in fixture
                  ? sql`jsonb_build_object('result', jsonb_build_object('state', ${fixture.state}::text))`
                  : sql`'{}'::jsonb`;
        const [result] = await db.execute(sql`
          WITH work_items AS (
            SELECT ${payload} AS payload,
              ${fixture.kind}::text AS kind,
              now()-${fixture.runAge}*interval '1 minute' AS run_at,
              now()-${fixture.createdAge}*interval '1 minute' AS created_at,
              ${fixture.attempts}::integer AS attempts,
              ${fixture.lease === null ? sql`NULL::timestamptz` : sql`now()+${fixture.lease}*interval '1 minute'`} AS lease_until,
              ${fixture.done ? sql`now()` : sql`NULL::timestamptz`} AS finished_at
          )
          SELECT ${piWatchQueueReadiness} AS healthy,
            created_at AS "createdAt",
            CASE WHEN jsonb_typeof(payload) = 'object' THEN payload->>'worker' END AS worker
          FROM work_items
        `);
        expect({ name: fixture.name, healthy: result?.healthy }).toEqual({
          name: fixture.name,
          healthy: fixture.healthy,
        });
        expect(result?.createdAt).toBeDefined();
        expect(JSON.stringify(result)).not.toContain("secret");
      }
    } finally {
      await db.$client.unsafe("ROLLBACK").catch(() => {});
      await db.$client.close();
    }
  },
);
