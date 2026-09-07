import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createHandoffStatusReader } from "../src/agents/handoff-status-tool";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const key = `hop:status-test:${randomUUID()}`;
const from = {
  actorId: `test-${randomUUID()}`,
  botId: "coord",
  threadId: "test-thread",
  runId: "test-run",
};
const reader = createHandoffStatusReader(database);
const queue = createWorkQueue(database);
afterAll(async () => {
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, "bot.message"),
        inArray(workItems.key, [key, `relay:${key}`]),
      ),
    );
  await database.$client.end({ timeout: 5 });
});
test("status is scoped to actor, sender and conversation, then exposes committed answer and relay", async () => {
  // Claim directly by key: never claim unrelated bot.message rows in this test database.
  await database
    .insert(workItems)
    .values({
      kind: "bot.message",
      key,
      payload: {
        actorId: from.actorId,
        fromBotId: from.botId,
        threadId: from.threadId,
      },
      claimedBy: "test-worker",
      leaseUntil: new Date(Date.now() + 60_000),
    });
  expect((await reader(from, key))?.status).toBe("running");
  expect(await reader({ ...from, actorId: "someone-else" }, key)).toBeNull();
  expect(await reader({ ...from, botId: "news" }, key)).toBeNull();
  expect(await reader({ ...from, threadId: "elsewhere" }, key)).toBeNull();
  await queue.finish({
    kind: "bot.message",
    key,
    owner: "test-worker",
    result: { answer: "Saved answer" },
    followUp: {
      kind: "bot.message",
      key: `relay:${key}`,
      payload: { answerIn: from.threadId },
    },
  });
  expect(await reader(from, key)).toEqual({
    jobId: key,
    status: "completed",
    answer: "Saved answer",
    returnStatus: "queued",
  });
  expect(await reader(from, `relay:${key}`)).toBeNull();
});
