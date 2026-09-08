import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue, type WorkQueue } from "../src/work/queue";
import { createPiWatcher, piWatchKey } from "../src/agents/pi-watch";
import { TEST_POOL } from "./support/database";
const prefix = `test.pi-watch.${randomUUID()}`;
const db = createDatabase(process.env.DATABASE_URL ?? "postgres://openbot:openbot@localhost:5432/openbot", TEST_POOL);
const actual = createWorkQueue(db);
const queue: WorkQueue = {
  ...actual,
  offer: input => actual.offer({ ...input, kind: `${prefix}.${input.kind}`, runAt: new Date(0) }),
  claim: input => actual.claim({ ...input, kind: `${prefix}.${input.kind}` }),
  release: input => actual.release({ ...input, kind: `${prefix}.${input.kind}` }),
  finish: input => actual.finish({ ...input, kind: `${prefix}.${input.kind}`, followUp: input.followUp ? { ...input.followUp, kind: `${prefix}.${input.followUp.kind}` } : undefined }),
};
afterAll(async () => {
  await db.delete(workItems).where(inArray(workItems.kind, [`${prefix}.pi.watch`, `${prefix}.bot.message`]));
  await db.$client.end({ timeout: 5 });
});
test("process rebuild and racing leases deliver one durable completion, never execute Pi again", async () => {
  const jobId = "b".repeat(32); let submits = 0, polls = 0;
  const receipt = { jobId, state: "completed", createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:01.000Z", result: { ok: true, output: "verified result" } };
  const store = { callTool: async () => { polls++; return { isError: false, text: JSON.stringify(receipt) }; } };
  const options = { queue, store, authorised: async () => true };
  const from = { actorId: prefix, botId: "code", threadId: "scratch", runId: "run", depth: 1, originRequest: { botId: "coord", threadId: "visible" } };
  const tool = { name: "pi", ref: "pi-m4/pi_run", description: "", parameters: z.object({}), execute: async () => { submits++; return JSON.stringify({ ...receipt, state: "queued", result: undefined }); } };
  await createPiWatcher({ ...options, owner: "old-process" }).observe(from, [tool])[0]!.execute({ background: true });
  await Promise.all([createPiWatcher({ ...options, owner: "new-a" }).sweep(), createPiWatcher({ ...options, owner: "new-b" }).sweep()]);
  await createPiWatcher({ ...options, owner: "new-c" }).sweep();
  const rows = await db.select().from(workItems).where(inArray(workItems.kind, [`${prefix}.pi.watch`, `${prefix}.bot.message`]));
  const watches = rows.filter(r => r.kind.endsWith("pi.watch")); const returns = rows.filter(r => r.kind.endsWith("bot.message"));
  expect(watches).toHaveLength(1); expect(watches[0]!.finishedAt).not.toBeNull();
  expect(returns).toHaveLength(1); expect(returns[0]!.payload).toMatchObject({ toBotId: "coord", answerIn: "visible", actorId: prefix });
  expect(polls).toBe(1); expect(submits).toBe(1);
  // A retry after completion collides with the durable watch, not another completion notification.
  await createPiWatcher({ ...options, owner: "new-d" }).observe(from, [tool])[0]!.execute({ background: true });
  await createPiWatcher({ ...options, owner: "new-d" }).sweep();
  expect(polls).toBe(1);
  expect((await db.select().from(workItems).where(eq(workItems.key, `pi-return:${piWatchKey(prefix, "pi-m4", jobId)}`)))).toHaveLength(1);
});
