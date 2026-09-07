import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users, routines, workItems } from "../src/db/schema";
import {
  createRoutineEventStore,
  routineEventIdentity,
} from "../src/routines/events";
if (!process.env.DATABASE_URL)
  throw new Error("Set isolated migrated DATABASE_URL");
const db = createDatabase(process.env.DATABASE_URL);
const owner = "event-test-" + randomUUID(),
  id = owner + "-routine",
  bot = owner + "-bot";
const store = createRoutineEventStore(db),
  input = { eventId: "event-1", evidence: "Evidence unchanged" };
const stamp = new Date("2030-01-01T00:00:00Z");
beforeAll(async () => {
  await db.insert(users).values({ id: owner, email: owner + "@example.test" });
  await db
    .insert(agents)
    .values({
      id: bot,
      name: "test",
      type: "built_in",
      configuration: { systemPrompt: "test" },
    });
  await db
    .insert(routines)
    .values({
      id,
      ownerUserId: owner,
      agentId: bot,
      channelId: "test",
      instruction: "Original instruction",
      cron: "0 7 * * *",
      nextRunAt: stamp,
    });
});
afterAll(async () => {
  await db.execute(
    sql`DELETE FROM work_items WHERE kind='routine.fire' AND payload->>'routineId'=${id}`,
  );
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(agents).where(eq(agents.id, bot));
  await db.$client.close();
});
test("simultaneous event retries create one persisted run and queue item, with unchanged schedule", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.offer(owner, id, input)),
  );
  expect(results.filter((x) => x.status === "accepted")).toHaveLength(1);
  expect(results.filter((x) => x.status === "already")).toHaveLength(4);
  const [run] = await db.execute(
    sql`SELECT instruction_snapshot,scheduled_for FROM routine_runs WHERE id=${routineEventIdentity(owner, id, input.eventId).runId}`,
  );
  expect(String(run.instruction_snapshot)).toStartWith("Original instruction");
  expect(String(run.instruction_snapshot)).toContain(
    "untrusted reference data",
  );
  expect(run.scheduled_for).toBeNull();
  const [r] = await db.select().from(routines).where(eq(routines.id, id));
  expect(r.nextRunAt.toISOString()).toBe(stamp.toISOString());
  const rows = await db
    .select()
    .from(workItems)
    .where(
      eq(workItems.key, routineEventIdentity(owner, id, input.eventId).key),
    );
  expect(rows).toHaveLength(1);
});
test("ownership and changed evidence fail closed; deletion of retained queue does not recreate event effects", async () => {
  expect(await store.offer("other", id, input)).toEqual({
    status: "not_found",
  });
  expect(
    await store.offer(owner, id, { ...input, evidence: "changed" }),
  ).toEqual({ status: "conflict" });
  await db
    .delete(workItems)
    .where(
      eq(workItems.key, routineEventIdentity(owner, id, input.eventId).key),
    );
  expect((await store.offer(owner, id, input)).status).toBe("already");
  expect(
    await db
      .select()
      .from(workItems)
      .where(
        eq(workItems.key, routineEventIdentity(owner, id, input.eventId).key),
      ),
  ).toHaveLength(0);
});
test("disabled routine rejects new events but permits reading identical prior acceptance", async () => {
  await db.update(routines).set({ enabled: false }).where(eq(routines.id, id));
  expect(await store.offer(owner, id, { ...input, eventId: "new" })).toEqual({
    status: "disabled",
  });
  expect((await store.offer(owner, id, input)).status).toBe("already");
});
