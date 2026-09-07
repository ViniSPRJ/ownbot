import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like, eq, and } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

const db = createDatabase(process.env.DATABASE_URL ?? "postgres://openbot:openbot@localhost:5432/openbot", TEST_POOL);
const queue = createWorkQueue(db);
const prefix = `priority-${randomUUID()}`;
afterAll(async () => {
  await db.delete(workItems).where(like(workItems.key, `${prefix}%`));
  await db.$client.end({timeout: 5});
});

test("urgent handoffs get a finite head start, respect eligibility and cannot starve older work", async () => {
  const kind = "bot.message";
  const base = new Date("2000-01-01T00:00:00Z").getTime();
  for (const [name, age, priority] of [["old", 0, "normal"], ["normal", 40_000, "normal"], ["urgent", 50_000, "urgent"], ["leased", -1000, "urgent"]] as const) {
    await queue.offer({kind, key: `${prefix}-${name}`, runAt: new Date(base + age), payload: {priority}});
  }
  await db.update(workItems).set({claimedBy: "other", leaseUntil: new Date(Date.now()+60_000)})
    .where(and(eq(workItems.kind,kind),eq(workItems.key,`${prefix}-leased`)));
  await queue.offer({kind, key: `${prefix}-future`, runAt: new Date(Date.now()+60_000),payload:{priority:"urgent"}});
  const claimed = await queue.claim({kind,owner:prefix,leaseMs:30_000,limit:3});
  expect(claimed.map(row=>row.key)).toEqual([`${prefix}-old`,`${prefix}-urgent`,`${prefix}-normal`]);
});

test("priority on another work kind cannot reorder routines or infrastructure work", async () => {
  const kind = `${prefix}.routine`;
  await queue.offer({kind,key:`${prefix}-routine-normal`,runAt:new Date(0)});
  await queue.offer({kind,key:`${prefix}-routine-urgent`,runAt:new Date(1000),payload:{priority:"urgent"}});
  const claimed = await queue.claim({kind,owner:prefix,leaseMs:30_000,limit:2});
  expect(claimed.map(row=>row.key)).toEqual([`${prefix}-routine-normal`,`${prefix}-routine-urgent`]);
});
