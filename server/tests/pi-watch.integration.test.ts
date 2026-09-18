import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  createPiWatcher,
  PI_WATCH_MAX_ATTEMPTS,
  piWatchKey,
} from "../src/agents/pi-watch";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue, type WorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

const url = process.env.TEST_DATABASE_URL;
const prefix = `test.pi-watch.${randomUUID()}`;

describe.skipIf(!url)("durable Pi completion watcher (postgres)", () => {
  const db = url
    ? createDatabase(url, TEST_POOL)
    : (null as unknown as ReturnType<typeof createDatabase>);
  const actual = url ? createWorkQueue(db) : (null as unknown as WorkQueue);
  const watchKind = `${prefix}.pi.watch`;
  const returnKind = `${prefix}.bot.message`;
  const queue: WorkQueue = url
    ? {
        ...actual,
        offer: (input) =>
          actual.offer({
            ...input,
            kind: `${prefix}.${input.kind}`,
            runAt: new Date(0),
          }),
        claim: (input) =>
          actual.claim({ ...input, kind: `${prefix}.${input.kind}` }),
        release: (input) =>
          actual.release({ ...input, kind: `${prefix}.${input.kind}` }),
        finish: (input) =>
          actual.finish({
            ...input,
            kind: `${prefix}.${input.kind}`,
            followUp: input.followUp
              ? {
                  ...input.followUp,
                  kind: `${prefix}.${input.followUp.kind}`,
                }
              : undefined,
          }),
        purge: (input) =>
          actual.purge({ ...input, kind: `${prefix}.${input.kind}` }),
      }
    : (null as unknown as WorkQueue);

  afterAll(async () => {
    if (!url) return;
    await db
      .delete(workItems)
      .where(inArray(workItems.kind, [watchKind, returnKind]));
    await db.$client.end({ timeout: 5 });
  });

  test("process rebuild and racing leases deliver one durable completion, never execute Pi again", async () => {
    const jobId = "b".repeat(32);
    let submits = 0,
      polls = 0;
    const receipt = {
      jobId,
      state: "completed",
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:01.000Z",
      result: { ok: true, output: "verified result" },
    };
    const store = {
      callTool: async () => {
        polls++;
        return { isError: false, text: JSON.stringify(receipt) };
      },
    };
    const options = { queue, store, authorised: async () => true };
    const from = {
      actorId: prefix,
      botId: "code",
      threadId: "scratch",
      runId: "run",
      depth: 1,
      originRequest: { botId: "coord", threadId: "visible" },
    };
    const tool = {
      name: "pi",
      ref: "pi-m4/pi_run",
      description: "",
      parameters: z.object({}),
      execute: async () => {
        submits++;
        return JSON.stringify({
          ...receipt,
          state: "queued",
          result: undefined,
        });
      },
    };
    await createPiWatcher({ ...options, owner: "old-process" })
      .observe(from, [tool])[0]!
      .execute({ background: true });
    await Promise.all([
      createPiWatcher({ ...options, owner: "new-a" }).sweep(),
      createPiWatcher({ ...options, owner: "new-b" }).sweep(),
    ]);
    await createPiWatcher({ ...options, owner: "new-c" }).sweep();
    const watchKey = piWatchKey(prefix, "pi-m4", jobId);
    const rows = await db
      .select()
      .from(workItems)
      .where(inArray(workItems.kind, [watchKind, returnKind]));
    const watches = rows.filter(
      (r) => r.kind === watchKind && r.key === watchKey,
    );
    const returns = rows.filter(
      (r) => r.kind === returnKind && r.key === `pi-return:${watchKey}`,
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]!.finishedAt).not.toBeNull();
    expect(returns).toHaveLength(1);
    expect(returns[0]!.payload).toMatchObject({
      toBotId: "coord",
      answerIn: "visible",
      actorId: prefix,
    });
    expect(polls).toBe(1);
    expect(submits).toBe(1);
    await createPiWatcher({ ...options, owner: "new-d" })
      .observe(from, [tool])[0]!
      .execute({ background: true });
    await createPiWatcher({ ...options, owner: "new-d" }).sweep();
    expect(polls).toBe(1);
    expect(
      await db
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, returnKind),
            eq(workItems.key, `pi-return:${watchKey}`),
          ),
        ),
    ).toHaveLength(1);
  });

  test("final-attempt crash recovery claims exhausted rows once without vendor work", async () => {
    const actorId = `${prefix}.exhausted`;
    const job = (digit: string) => {
      const jobId = digit.repeat(32);
      return { jobId, key: piWatchKey(actorId, "pi-m4", jobId) };
    };
    const expired = job("c");
    const nullLease = job("d");
    const below = job("e");
    const active = job("f");
    const done = job("a");
    const payload = (jobId: string) => ({
      actorId,
      botId: "code",
      threadId: "scratch",
      runId: "run",
      depth: 1,
      worker: "pi-m4",
      jobId,
      originRequest: { botId: "coord", threadId: "visible" },
      createdAt: Date.now(),
      protocolVersion: 1 as const,
      submitTool: "pi-m4/pi_run",
      statusTool: "pi-m4/pi_status",
    });
    await db.insert(workItems).values([
      {
        kind: watchKind,
        key: expired.key,
        payload: payload(expired.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: "dead-owner",
        leaseUntil: new Date(0),
        runAt: new Date(0),
      },
      {
        kind: watchKind,
        key: nullLease.key,
        payload: payload(nullLease.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: null,
        leaseUntil: null,
        runAt: new Date(0),
      },
      {
        kind: watchKind,
        key: below.key,
        payload: payload(below.jobId),
        attempts: 1,
        claimedBy: null,
        leaseUntil: null,
        runAt: new Date(0),
      },
      {
        kind: watchKind,
        key: active.key,
        payload: payload(active.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: "live-owner",
        leaseUntil: new Date(Date.now() + 60 * 60 * 1000),
        runAt: new Date(0),
      },
      {
        kind: watchKind,
        key: done.key,
        payload: payload(done.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: null,
        leaseUntil: null,
        finishedAt: new Date(),
        runAt: new Date(0),
      },
    ]);

    const ordinaryDefault = await actual.claim({
      kind: watchKind,
      owner: "generic-queue",
      leaseMs: 60_000,
      limit: 10,
    });
    expect(ordinaryDefault).toHaveLength(1);
    expect(ordinaryDefault[0]!.key).toBe(below.key);
    expect(ordinaryDefault[0]!.attempts).toBe(2);

    const ordinaryAtCap = await actual.claim({
      kind: watchKind,
      owner: "generic-queue-2",
      leaseMs: 60_000,
      limit: 10,
      maxAttempts: PI_WATCH_MAX_ATTEMPTS,
    });
    expect(ordinaryAtCap).toHaveLength(0);

    let polls = 0;
    const store = {
      callTool: async () => {
        polls++;
        return {
          isError: true,
          text: "vendor must not run for exhausted recovery",
        };
      },
    };
    const options = { queue, store, authorised: async () => true };

    await Promise.all([
      createPiWatcher({ ...options, owner: "rebuilt-a" }).sweep(),
      createPiWatcher({ ...options, owner: "rebuilt-b" }).sweep(),
    ]);
    await createPiWatcher({ ...options, owner: "rebuilt-c" }).sweep();
    await createPiWatcher({ ...options, owner: "rebuilt-c" }).sweep();

    const rows = await db
      .select()
      .from(workItems)
      .where(inArray(workItems.kind, [watchKind, returnKind]));
    const byKey = new Map(rows.map((row) => [row.key, row]));

    for (const recovered of [expired, nullLease]) {
      const watch = byKey.get(recovered.key);
      expect(watch).toBeDefined();
      if (!watch) continue;
      expect(watch.finishedAt).not.toBeNull();
      expect(watch.attempts).toBe(PI_WATCH_MAX_ATTEMPTS);
      const result = (
        watch.payload as { result?: { state?: string; evidence?: string } }
      ).result;
      expect(result?.state).toBe("unknown");
      expect(result?.evidence).toContain("attempt budget");
      expect(result?.evidence).not.toContain("24-hour tracking window");
      const returns = rows.filter(
        (row) =>
          row.kind === returnKind && row.key === `pi-return:${recovered.key}`,
      );
      expect(returns).toHaveLength(1);
      expect(returns[0]?.payload).toMatchObject({
        toBotId: "coord",
        answerIn: "visible",
        actorId,
      });
    }

    const live = byKey.get(active.key);
    expect(live).toBeDefined();
    expect(live?.finishedAt).toBeNull();
    expect(live?.claimedBy).toBe("live-owner");
    expect(live?.attempts).toBe(PI_WATCH_MAX_ATTEMPTS);

    const finished = byKey.get(done.key);
    expect(finished).toBeDefined();
    expect(finished?.finishedAt).not.toBeNull();
    expect(
      rows.filter(
        (row) => row.kind === returnKind && row.key === `pi-return:${done.key}`,
      ),
    ).toHaveLength(0);

    const held = byKey.get(below.key);
    expect(held).toBeDefined();
    expect(held?.finishedAt).toBeNull();
    expect(held?.claimedBy).toBe("generic-queue");
    expect(held?.attempts).toBe(2);

    expect(polls).toBe(0);
    expect(
      rows.filter((row) => {
        const payload = row.payload as { actorId?: string };
        return row.kind === returnKind && payload.actorId === actorId;
      }),
    ).toHaveLength(2);
  });

  test("reap keeps unfinished watches including a backlog larger than the sweep batch", async () => {
    const actorId = `${prefix}.reap`;
    const job = (digit: string) => {
      const jobId = digit.repeat(32);
      return { jobId, key: piWatchKey(actorId, "pi-m4", jobId) };
    };
    const pendingExpiredA = job("0");
    const pendingExpiredB = job("1");
    const pendingNull = job("2");
    const active = job("3");
    const done = job("4");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const payload = (jobId: string) => ({
      actorId,
      botId: "code",
      threadId: "scratch",
      runId: "run",
      depth: 1,
      worker: "pi-m4",
      jobId,
      originRequest: { botId: "coord", threadId: "visible" },
      createdAt: old.getTime(),
      protocolVersion: 1 as const,
      submitTool: "pi-m4/pi_run",
      statusTool: "pi-m4/pi_status",
    });
    await db.insert(workItems).values([
      {
        kind: watchKind,
        key: pendingExpiredA.key,
        payload: payload(pendingExpiredA.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: "dead-owner",
        leaseUntil: new Date(0),
        runAt: new Date(0),
        updatedAt: old,
      },
      {
        kind: watchKind,
        key: pendingExpiredB.key,
        payload: payload(pendingExpiredB.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: "dead-owner",
        leaseUntil: new Date(0),
        runAt: new Date(0),
        updatedAt: old,
      },
      {
        kind: watchKind,
        key: pendingNull.key,
        payload: payload(pendingNull.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: null,
        leaseUntil: null,
        runAt: new Date(0),
        updatedAt: old,
      },
      {
        kind: watchKind,
        key: active.key,
        payload: payload(active.jobId),
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: "live-owner",
        leaseUntil: new Date(Date.now() + 60 * 60 * 1000),
        runAt: new Date(0),
        updatedAt: old,
      },
      {
        kind: watchKind,
        key: done.key,
        payload: {
          ...payload(done.jobId),
          result: { state: "completed" },
        },
        attempts: PI_WATCH_MAX_ATTEMPTS,
        claimedBy: null,
        leaseUntil: null,
        finishedAt: old,
        runAt: new Date(0),
        updatedAt: old,
      },
    ]);

    let polls = 0;
    const store = {
      callTool: async () => {
        polls++;
        return {
          isError: true,
          text: "vendor must not run for exhausted recovery",
        };
      },
    };
    const watcher = createPiWatcher({
      queue,
      store,
      authorised: async () => true,
      owner: "reaper",
    });
    expect(await watcher.reap()).toBe(1);

    const afterReap = await db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, watchKind),
          inArray(workItems.key, [
            pendingExpiredA.key,
            pendingExpiredB.key,
            pendingNull.key,
            active.key,
            done.key,
          ]),
        ),
      );
    const afterReapKeys = afterReap.map((row) => row.key).sort();
    expect(afterReapKeys).toEqual(
      [
        pendingExpiredA.key,
        pendingExpiredB.key,
        pendingNull.key,
        active.key,
      ].sort(),
    );
    expect(afterReap.filter((row) => row.finishedAt == null)).toHaveLength(4);

    for (let i = 0; i < 6; i += 1) {
      await createPiWatcher({
        queue,
        store,
        authorised: async () => true,
        owner: `rebuilt-reap-${i}`,
      }).sweep();
    }

    const rows = await db
      .select()
      .from(workItems)
      .where(inArray(workItems.kind, [watchKind, returnKind]));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const recovered of [pendingExpiredA, pendingExpiredB, pendingNull]) {
      const watch = byKey.get(recovered.key);
      expect(watch).toBeDefined();
      if (!watch) continue;
      expect(watch.finishedAt).not.toBeNull();
      expect(watch.attempts).toBe(PI_WATCH_MAX_ATTEMPTS);
      const result = (
        watch.payload as { result?: { state?: string; evidence?: string } }
      ).result;
      expect(result?.state).toBe("unknown");
      expect(result?.evidence).toContain("attempt budget");
    }
    const live = byKey.get(active.key);
    expect(live).toBeDefined();
    expect(live?.finishedAt).toBeNull();
    expect(live?.claimedBy).toBe("live-owner");
    expect(live?.attempts).toBe(PI_WATCH_MAX_ATTEMPTS);
    expect(byKey.get(done.key)).toBeUndefined();
    expect(
      rows.filter((row) => {
        const payload = row.payload as { actorId?: string };
        return row.kind === returnKind && payload.actorId === actorId;
      }),
    ).toHaveLength(3);
    expect(polls).toBe(0);
  });
});
