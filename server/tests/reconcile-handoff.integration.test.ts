import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  loadPreparedManifest,
  RESOLUTION,
  reconcileHandoffs,
} from "../scripts/reconcile-handoff";

const url = process.env.TEST_DATABASE_URL;
const dirs: string[] = [];
const keys: string[] = [];

function workKey(label: string): string {
  const value = `hop:reconcile-test:${label}:${crypto.randomUUID()}`;
  keys.push(value);
  return value;
}

async function writeSecret(
  dir: string,
  name: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  const path = join(dir, name);
  const buf = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(path, buf);
  await chmod(path, 0o600);
  return {
    path,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

const unknownResult = {
  outcome: "unknown",
  reason: "Previous delivery was admitted; outcome unknown.",
};

describe.skipIf(!url)("handoff reconciliation SQL", () => {
  const sql = url
    ? postgres(url, { max: 1, onnotice: () => {} })
    : (null as unknown as postgres.Sql);

  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (!url) return;
    if (keys.length > 0) {
      const relayKeys = keys.map((value) => `relay:${value}`);
      await sql`
        DELETE FROM work_items
        WHERE kind = 'bot.message' AND key = ANY(${[...keys, ...relayKeys]})
      `;
    }
    await sql.end({ timeout: 5 });
  });

  async function insertUnknown(
    key: string,
    extras: Record<string, unknown> = {},
  ): Promise<void> {
    await sql`
      INSERT INTO work_items (kind, key, payload, finished_at, attempts)
      VALUES (
        'bot.message',
        ${key},
        ${sql.json({
          actorId: "actor-1",
          fromBotId: "coord",
          toBotId: "news",
          threadId: "thread-1",
          runId: "run-1",
          task: "SECRET TASK CONTENT",
          result: unknownResult,
          ...extras,
        })},
        now(),
        1
      )
    `;
  }

  async function archiveFor(key: string, result = unknownResult) {
    const dir = await mkdtemp(join(tmpdir(), "reconcile-sql-"));
    dirs.push(dir);
    const receipt = await writeSecret(dir, "receipt.json", {
      workKey: key,
      originalResult: result,
      resolution: RESOLUTION,
      originalDeliveryOutcome: "unknown",
      id: `receipt-${key.slice(-8)}`,
      note: "internal archive of the original alert",
    });
    const manifestFile = await writeSecret(dir, "manifest.json", {
      version: 1,
      operator: "operator-1",
      entries: [
        {
          workKey: key,
          expectedResult: result,
          receiptPath: receipt.path,
          receiptSha256: receipt.sha256,
          resolution: RESOLUTION,
          evidenceRefs: ["audit:agent.handoff_failed"],
        },
      ],
    });
    return loadPreparedManifest(manifestFile.path);
  }

  async function payloadOf(key: string) {
    const [row] = await sql`
      SELECT payload, finished_at, claimed_by, lease_until
      FROM work_items WHERE kind = 'bot.message' AND key = ${key}
    `;
    return row as {
      payload: Record<string, unknown>;
      finished_at: Date;
      claimed_by: string | null;
      lease_until: Date | null;
    };
  }

  async function auditCount(key: string): Promise<number> {
    const [row] = await sql`
      SELECT count(*)::int AS n
      FROM audit_events
      WHERE event_type = 'agent.handoff_reconciled'
        AND target_type = 'work_item'
        AND target_id = ${key}
    `;
    return Number((row as { n: number }).n);
  }

  test("dry-run leaves the unknown row untouched", async () => {
    const key = workKey("dry");
    await insertUnknown(key);
    const prepared = await archiveFor(key);
    const before = await payloadOf(key);
    const report = await reconcileHandoffs({
      sql,
      ...prepared,
      apply: false,
    });
    expect(report.mode).toBe("dry-run");
    expect(report.entries).toEqual([
      {
        workKey: key,
        action: "would_reconcile",
        receiptSha256: prepared.prepared[0]!.receiptSha256,
        receiptId: prepared.prepared[0]!.receiptId,
        resolution: RESOLUTION,
        fromBotId: "coord",
        toBotId: "news",
        runId: "run-1",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("SECRET TASK CONTENT");
    const after = await payloadOf(key);
    expect(after.payload).toEqual(before.payload);
    expect(after.finished_at.getTime()).toBe(before.finished_at.getTime());
    expect(await auditCount(key)).toBe(0);
  });

  test("apply archives the original result, writes one event, and does not offer a relay", async () => {
    const key = workKey("apply");
    await insertUnknown(key);
    const prepared = await archiveFor(key);
    const before = await payloadOf(key);
    const report = await reconcileHandoffs({
      sql,
      ...prepared,
      apply: true,
    });
    expect(report.entries[0]?.action).toBe("reconciled");
    expect(JSON.stringify(report)).not.toContain("SECRET TASK CONTENT");
    const after = await payloadOf(key);
    expect(after.finished_at.getTime()).toBe(before.finished_at.getTime());
    expect(after.claimed_by).toBeNull();
    expect(after.lease_until).toBeNull();
    expect(after.payload.actorId).toBe("actor-1");
    expect(after.payload.task).toBe("SECRET TASK CONTENT");
    expect(after.payload.result).toMatchObject({
      outcome: "reconciled",
      originalOutcome: "unknown",
      previousResult: unknownResult,
      resolution: RESOLUTION,
      receiptId: prepared.prepared[0]!.receiptId,
      receiptPath: prepared.prepared[0]!.receiptPath,
      receiptSha256: prepared.prepared[0]!.receiptSha256,
      evidenceRefs: ["audit:agent.handoff_failed"],
      recipientDeliveryConfirmed: false,
    });
    expect(await auditCount(key)).toBe(1);
    const [event] = await sql`
      SELECT actor_user_id, payload
      FROM audit_events
      WHERE event_type = 'agent.handoff_reconciled' AND target_id = ${key}
    `;
    expect((event as { actor_user_id: string }).actor_user_id).toBe(
      "operator-1",
    );
    const eventPayload = (event as { payload: Record<string, unknown> })
      .payload;
    expect(eventPayload).toMatchObject({
      originalOutcome: "unknown",
      resolution: RESOLUTION,
      workKey: key,
      from: "coord",
      to: "news",
      run: "run-1",
      recipientDeliveryConfirmed: false,
    });
    expect(JSON.stringify(eventPayload)).not.toContain("SECRET TASK CONTENT");
    const relays = await sql`
      SELECT key FROM work_items WHERE kind = 'bot.message' AND key = ${`relay:${key}`}
    `;
    expect(relays).toHaveLength(0);
  });

  test("the same receipt is idempotent and a changed receipt fails closed", async () => {
    const key = workKey("idem");
    await insertUnknown(key);
    const first = await archiveFor(key);
    await reconcileHandoffs({ sql, ...first, apply: true });
    expect(await auditCount(key)).toBe(1);
    const repeat = await reconcileHandoffs({ sql, ...first, apply: true });
    expect(repeat.entries[0]?.action).toBe("already_reconciled");
    expect(await auditCount(key)).toBe(1);

    const dir = await mkdtemp(join(tmpdir(), "reconcile-conflict-"));
    dirs.push(dir);
    const other = await writeSecret(dir, "other.json", {
      workKey: key,
      originalResult: unknownResult,
      resolution: RESOLUTION,
      originalDeliveryOutcome: "unknown",
      id: "other-receipt",
      note: "different archive",
    });
    const conflict = await writeSecret(dir, "manifest.json", {
      version: 1,
      operator: "operator-1",
      entries: [
        {
          workKey: key,
          expectedResult: unknownResult,
          receiptPath: other.path,
          receiptSha256: other.sha256,
          resolution: RESOLUTION,
          evidenceRefs: ["audit:agent.handoff_failed"],
        },
      ],
    });
    const prepared = await loadPreparedManifest(conflict.path);
    await expect(
      reconcileHandoffs({ sql, ...prepared, apply: true }),
    ).rejects.toThrow("different archive");
    expect(await auditCount(key)).toBe(1);
  });

  test("conflicting live state fails closed and a multi-entry apply is all-or-nothing", async () => {
    const finished = workKey("ok");
    const live = workKey("live");
    await insertUnknown(finished);
    await sql`
      INSERT INTO work_items (kind, key, payload, attempts, claimed_by, lease_until)
      VALUES (
        'bot.message',
        ${live},
        ${sql.json({
          actorId: "actor-1",
          fromBotId: "coord",
          toBotId: "news",
          threadId: "thread-1",
          runId: "run-1",
          result: unknownResult,
        })},
        1,
        'worker-1',
        now() + interval '1 hour'
      )
    `;
    const dir = await mkdtemp(join(tmpdir(), "reconcile-multi-"));
    dirs.push(dir);
    const receipts = [];
    for (const key of [finished, live]) {
      receipts.push(
        await writeSecret(dir, `${key}.json`, {
          workKey: key,
          originalResult: unknownResult,
          resolution: RESOLUTION,
          originalDeliveryOutcome: "unknown",
          id: key,
          note: "internal archive of the original alert",
        }),
      );
    }
    const manifest = await writeSecret(dir, "manifest.json", {
      version: 1,
      operator: "operator-1",
      entries: [finished, live].map((key, index) => ({
        workKey: key,
        expectedResult: unknownResult,
        receiptPath: receipts[index]!.path,
        receiptSha256: receipts[index]!.sha256,
        resolution: RESOLUTION,
        evidenceRefs: [],
      })),
    });
    const prepared = await loadPreparedManifest(manifest.path);
    await expect(
      reconcileHandoffs({ sql, ...prepared, apply: true }),
    ).rejects.toThrow(/not finished|actively leased/);
    expect((await payloadOf(finished)).payload.result).toEqual(unknownResult);
    expect(await auditCount(finished)).toBe(0);
    expect(await auditCount(live)).toBe(0);
  });

  test("an actively leased finished row and a result mismatch fail closed", async () => {
    const leased = workKey("leased");
    const mismatch = workKey("mismatch");
    await sql`
      INSERT INTO work_items (kind, key, payload, finished_at, claimed_by, lease_until)
      VALUES (
        'bot.message',
        ${leased},
        ${sql.json({
          actorId: "actor-1",
          fromBotId: "coord",
          toBotId: "news",
          threadId: "thread-1",
          runId: "run-1",
          result: unknownResult,
        })},
        now(),
        'worker-1',
        now() + interval '1 hour'
      )
    `;
    await insertUnknown(mismatch);
    const leasedArchive = await archiveFor(leased);
    await expect(
      reconcileHandoffs({ sql, ...leasedArchive, apply: false }),
    ).rejects.toThrow("actively leased");
    const otherResult = { outcome: "unknown", reason: "different" };
    const mismatchArchive = await archiveFor(mismatch, otherResult);
    await expect(
      reconcileHandoffs({ sql, ...mismatchArchive, apply: false }),
    ).rejects.toThrow("does not match expectedResult");
  });

  test("a stale lease on a finished unknown row is cleared only while applying", async () => {
    const key = workKey("stale");
    await sql`
      INSERT INTO work_items (kind, key, payload, finished_at, claimed_by, lease_until)
      VALUES (
        'bot.message',
        ${key},
        ${sql.json({
          actorId: "actor-1",
          fromBotId: "coord",
          toBotId: "news",
          threadId: "thread-1",
          runId: "run-1",
          result: unknownResult,
        })},
        now(),
        'dead-worker',
        now() - interval '1 hour'
      )
    `;
    const prepared = await archiveFor(key);
    await reconcileHandoffs({ sql, ...prepared, apply: true });
    const after = await payloadOf(key);
    expect(after.claimed_by).toBeNull();
    expect(after.lease_until).toBeNull();
    expect((after.payload.result as { outcome: string }).outcome).toBe(
      "reconciled",
    );
  });
});
