import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createHandoffStatusReader } from "../src/agents/handoff-status-tool";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("handoff status SQL semantics", () => {
  const database = url
    ? createDatabase(url, TEST_POOL)
    : (null as unknown as ReturnType<typeof createDatabase>);
  const keys: string[] = [];
  const from = {
    actorId: `test-${randomUUID()}`,
    botId: "coord",
    threadId: "test-thread",
    runId: "test-run",
  };
  const reader = url ? createHandoffStatusReader(database) : null;
  const queue = url ? createWorkQueue(database) : null;

  function key(label: string): string {
    const value = `hop:status-test:${label}:${randomUUID()}`;
    keys.push(value);
    return value;
  }

  afterAll(async () => {
    if (!url) return;
    const relayKeys = keys.map((value) => `relay:${value}`);
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "bot.message"),
          inArray(workItems.key, [...keys, ...relayKeys]),
        ),
      );
    await database.$client.end({ timeout: 5 });
  });

  test("status is scoped to actor, sender and conversation, then exposes committed answer and relay", async () => {
    const jobId = key("scope");
    await database.insert(workItems).values({
      kind: "bot.message",
      key: jobId,
      payload: {
        actorId: from.actorId,
        fromBotId: from.botId,
        threadId: from.threadId,
      },
      claimedBy: "test-worker",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    expect((await reader!(from, jobId))?.status).toBe("running");
    expect(
      await reader!({ ...from, actorId: "someone-else" }, jobId),
    ).toBeNull();
    expect(await reader!({ ...from, botId: "news" }, jobId)).toBeNull();
    expect(await reader!({ ...from, threadId: "elsewhere" }, jobId)).toBeNull();
    await queue!.finish({
      kind: "bot.message",
      key: jobId,
      owner: "test-worker",
      result: { answer: "Saved answer" },
      followUp: {
        kind: "bot.message",
        key: `relay:${jobId}`,
        payload: { answerIn: from.threadId },
      },
    });
    expect(await reader!(from, jobId)).toEqual({
      jobId,
      status: "completed",
      answer: "Saved answer",
      returnStatus: "queued",
    });
    expect(await reader!(from, `relay:${jobId}`)).toBeNull();
  });

  test("a finished hop with outcome unknown is unknown, not completed", async () => {
    const jobId = key("unknown");
    await database.insert(workItems).values({
      kind: "bot.message",
      key: jobId,
      finishedAt: new Date(),
      payload: {
        actorId: from.actorId,
        fromBotId: from.botId,
        threadId: from.threadId,
        result: { outcome: "unknown", reason: "admitted" },
      },
    });
    expect(await reader!(from, jobId)).toEqual({
      jobId,
      status: "unknown",
      answer: null,
      returnStatus: null,
    });
  });

  test("a finished hop with outcome reconciled reports reconciled and its resolution", async () => {
    const jobId = key("reconciled");
    await database.insert(workItems).values({
      kind: "bot.message",
      key: jobId,
      finishedAt: new Date(),
      payload: {
        actorId: from.actorId,
        fromBotId: from.botId,
        threadId: from.threadId,
        result: {
          outcome: "reconciled",
          resolution: "internal_record_archived",
          originalOutcome: "unknown",
        },
      },
    });
    expect(await reader!(from, jobId)).toEqual({
      jobId,
      status: "reconciled",
      answer: null,
      returnStatus: null,
      resolution: "internal_record_archived",
    });
  });

  test("a finished relay with outcome unknown is unknown, never processed", async () => {
    const jobId = key("relay-unknown");
    await database.insert(workItems).values({
      kind: "bot.message",
      key: jobId,
      finishedAt: new Date(),
      payload: {
        actorId: from.actorId,
        fromBotId: from.botId,
        threadId: from.threadId,
        result: { answer: "Saved answer" },
      },
    });
    await database.insert(workItems).values({
      kind: "bot.message",
      key: `relay:${jobId}`,
      finishedAt: new Date(),
      payload: {
        answerIn: from.threadId,
        result: { outcome: "unknown", reason: "admitted" },
      },
    });
    expect(await reader!(from, jobId)).toEqual({
      jobId,
      status: "completed",
      answer: "Saved answer",
      returnStatus: "unknown",
    });
  });
});
