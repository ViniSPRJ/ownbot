import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { PI_WATCH_MAX_ATTEMPTS } from "../src/agents/pi-watch";
import type { Database } from "../src/db/client";
import {
  createOperationsStore,
  piDelegationFromRow,
  piWatchQueueReadiness,
} from "../src/operations/store";

const JOB = "a".repeat(32);
const KEY = "b".repeat(64);

function storeWith(rows: unknown[]) {
  const dialect = new PgDialect();
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const database = {
    execute: async (query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      return rows;
    },
  } as unknown as Database;
  return { store: createOperationsStore(database), queries };
}

describe("Pi delegation projection", () => {
  test("allowlists fields and never copies raw payload, evidence, errors or MCP refs", () => {
    const projected = piDelegationFromRow({
      key: KEY,
      worker: "pi-m5",
      jobId: JOB,
      attempts: 3,
      finished: true,
      resultState: "completed",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      runAt: new Date("2026-09-01T00:01:00.000Z"),
      finishedAt: new Date("2026-09-01T00:02:00.000Z"),
      leaseUntil: null,
      payload: {
        evidence: "secret-output",
        error: "private failure",
        submitTool: "pi-m5/pi_run",
        statusTool: "pi-m5/pi_status",
        task: "Do not leak this prompt",
      },
      lastError: "Pi status unavailable; job not rerun.",
      result: { evidence: { path: "/var/lib/openbot/secret" } },
    });
    expect(Object.keys(projected).sort()).toEqual([
      "attempts",
      "createdAt",
      "executor",
      "finishedAt",
      "jobId",
      "key",
      "leaseUntil",
      "lifecycle",
      "runAt",
      "terminalState",
    ]);
    expect(projected).toMatchObject({
      key: KEY,
      executor: "pi-m5",
      jobId: JOB,
      lifecycle: "terminal",
      terminalState: "completed",
      attempts: 3,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("secret-output");
    expect(serialized).not.toContain("private failure");
    expect(serialized).not.toContain("pi_run");
    expect(serialized).not.toContain("pi_status");
    expect(serialized).not.toContain("/var/lib");
    expect(serialized).not.toContain("prompt");
  });

  test("malformed strings are bounded and dropped rather than echoed", () => {
    const projected = piDelegationFromRow({
      key: "/home/openbot/.ssh/id_rsa",
      worker: "pi-m5/pi_status",
      jobId: "not a job id and also a prompt: ignore previous instructions",
      attempts: "nope",
      finished: false,
      liveLease: false,
      resultState: "completed",
    });
    expect(projected.key).toBeNull();
    expect(projected.executor).toBeNull();
    expect(projected.jobId).toBeNull();
    expect(projected.attempts).toBe(0);
    expect(projected.lifecycle).not.toBe("terminal");
    expect(projected.terminalState).toBeNull();
  });

  test("oversized or numeric identifiers are rejected whole, exact max length is kept", () => {
    expect(
      piDelegationFromRow({ jobId: `${JOB}b`, key: KEY, worker: "pi-m5" })
        .jobId,
    ).toBeNull();
    expect(
      piDelegationFromRow({
        jobId: JOB,
        key: KEY,
        worker: "a".repeat(65),
      }).executor,
    ).toBeNull();
    expect(
      piDelegationFromRow({
        jobId: JOB,
        key: `${"c".repeat(129)}`,
        worker: "pi-m5",
      }).key,
    ).toBeNull();
    expect(
      piDelegationFromRow({ jobId: 1, worker: 2, key: 3 }).jobId,
    ).toBeNull();
    expect(
      piDelegationFromRow({ jobId: 1, worker: 2, key: 3 }).executor,
    ).toBeNull();
    expect(piDelegationFromRow({ jobId: 1, worker: 2, key: 3 }).key).toBeNull();
    expect(piDelegationFromRow({ jobId: JOB }).jobId).toBe(JOB);
    expect(piDelegationFromRow({ worker: "a".repeat(64) }).executor).toBe(
      "a".repeat(64),
    );
    expect(piDelegationFromRow({ key: "d".repeat(128) }).key).toBe(
      "d".repeat(128),
    );
  });

  test("invalid or unknown terminal labels never become completed", () => {
    for (const resultState of [
      "success",
      "ok",
      "done",
      "COMPLETE",
      "completed ",
      null,
      { ok: true },
    ]) {
      const projected = piDelegationFromRow({
        key: KEY,
        finished: true,
        resultState,
      });
      expect(projected.lifecycle).toBe("terminal");
      expect(projected.terminalState).not.toBe("completed");
      expect(projected.terminalState).toBe("unknown");
    }
    expect(
      piDelegationFromRow({
        key: KEY,
        finished: false,
        liveLease: false,
        resultState: "completed",
      }).terminalState,
    ).toBeNull();
    expect(
      piDelegationFromRow({
        key: KEY,
        finished: false,
        liveLease: false,
        resultState: "completed",
      }).lifecycle,
    ).not.toBe("terminal");
  });

  test("access_revoked stays distinct from success, and completed is a receipt not a delivery", () => {
    const revoked = piDelegationFromRow({
      key: KEY,
      finished: true,
      resultState: "access_revoked",
    });
    expect(revoked.lifecycle).toBe("terminal");
    expect(revoked.terminalState).toBe("access_revoked");
    expect(revoked.terminalState).not.toBe("completed");
    const completed = piDelegationFromRow({
      key: KEY,
      finished: true,
      resultState: "completed",
    });
    expect(completed.terminalState).toBe("completed");
    expect(completed.lifecycle).toBe("terminal");
  });

  test("pending lifecycle is honest about leases, retries, age and unknown rows", () => {
    const now = Date.parse("2026-09-17T12:00:00.000Z");
    expect(
      piDelegationFromRow(
        {
          key: KEY,
          finished: false,
          liveLease: true,
          attempts: PI_WATCH_MAX_ATTEMPTS,
          staleRunAt: true,
          aged: true,
        },
        now,
      ).lifecycle,
    ).toBe("watching");
    expect(
      piDelegationFromRow(
        {
          key: KEY,
          finished: false,
          liveLease: false,
          attempts: PI_WATCH_MAX_ATTEMPTS,
        },
        now,
      ).lifecycle,
    ).toBe("exhausted");
    expect(
      piDelegationFromRow(
        {
          key: KEY,
          finished: false,
          liveLease: false,
          attempts: 1,
          staleRunAt: true,
        },
        now,
      ).lifecycle,
    ).toBe("overdue");
    expect(
      piDelegationFromRow(
        {
          key: KEY,
          finished: false,
          liveLease: false,
          attempts: 1,
          aged: true,
        },
        now,
      ).lifecycle,
    ).toBe("overdue");
    expect(
      piDelegationFromRow(
        {
          key: KEY,
          finished: false,
          liveLease: false,
          attempts: 1,
          staleRunAt: false,
          aged: false,
        },
        now,
      ).lifecycle,
    ).toBe("queued");
    expect(piDelegationFromRow(null, now).lifecycle).toBe("unknown");
    expect(
      piDelegationFromRow({ finished: true, resultState: "failed" }, now)
        .terminalState,
    ).toBe("failed");
    expect(
      piDelegationFromRow({ finished: true, resultState: "interrupted" }, now)
        .terminalState,
    ).toBe("interrupted");
    expect(
      piDelegationFromRow({ finished: true, resultState: "unknown" }, now)
        .terminalState,
    ).toBe("unknown");
  });

  test("displayed createdAt comes only from the database column", () => {
    const fromDatabase = piDelegationFromRow({
      key: KEY,
      finished: false,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      payloadCreatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
    });
    expect(fromDatabase.createdAt).toBe("2026-09-02T00:00:00.000Z");
    expect(
      piDelegationFromRow({
        payloadCreatedAt: Date.parse("2026-09-01T00:00:00.000Z"),
      }).createdAt,
    ).toBeNull();
    expect(
      piDelegationFromRow({ payloadCreatedAt: "secret" }).createdAt,
    ).toBeNull();
    expect(
      piDelegationFromRow({ payloadCreatedAt: { nested: true } }).createdAt,
    ).toBeNull();
    expect(
      piDelegationFromRow({ payloadCreatedAt: "1e1000" }).createdAt,
    ).toBeNull();
    expect(
      piDelegationFromRow({ createdAt: "totally-not-iso" }).createdAt,
    ).toBeNull();
  });
});

describe("Pi delegation SQL", () => {
  test("binds owner, filters pi.watch, limits to 50 newest, and does not select raw payload fields", async () => {
    const { store, queries } = storeWith([]);
    await store.piDelegations("owner-secret");
    const query = queries[0];
    expect(query?.sql).toContain("kind=$");
    expect(query?.sql).toContain("payload->>'actorId'=$");
    expect(query?.sql).toContain("LIMIT $");
    expect(query?.sql).toContain("ORDER BY created_at DESC");
    expect(query?.params).toContain("pi.watch");
    expect(query?.params).toContain("owner-secret");
    expect(query?.params).toContain(50);
    expect(query?.sql).not.toContain("owner-secret");
    expect(query?.sql).not.toContain("last_error");
    expect(query?.sql).not.toContain("claimed_by");
    expect(query?.sql).not.toContain("evidence");
    expect(query?.sql).not.toContain("submitTool");
    expect(query?.sql).not.toContain("statusTool");
    expect(query?.sql).not.toContain("lastError");
    expect(query?.sql).toContain("payload->>'worker'");
    expect(query?.sql).toContain("payload->>'jobId'");
    expect(query?.sql).toContain("jsonb_typeof(payload->'worker') = 'string'");
    expect(query?.sql).toContain("jsonb_typeof(payload->'jobId') = 'string'");
    expect(query?.sql).toContain("payload->'result'->>'state'");
    expect(query?.sql).not.toContain("payloadCreatedAt");
    expect(query?.sql).not.toContain("payload->>'createdAt'");
    expect(query?.sql).not.toContain("to_timestamp");
  });

  test("store maps rows through the allowlist and ignores extra columns the driver might attach", async () => {
    const { store } = storeWith([
      {
        key: KEY,
        worker: "lab-worker",
        jobId: JOB,
        attempts: 2,
        finished: false,
        liveLease: true,
        staleRunAt: false,
        aged: false,
        createdAt: "2026-09-17T00:00:00.000Z",
        runAt: "2026-09-17T00:01:00.000Z",
        finishedAt: null,
        leaseUntil: "2026-09-17T00:02:00.000Z",
        payload: { evidence: "nope" },
        last_error: "hidden",
      },
    ]);
    const [row] = await store.piDelegations("alice");
    expect(row).toMatchObject({
      key: KEY,
      executor: "lab-worker",
      jobId: JOB,
      lifecycle: "watching",
      terminalState: null,
      attempts: 2,
    });
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("last_error");
    expect(JSON.stringify(row)).not.toContain("nope");
    expect(JSON.stringify(row)).not.toContain("hidden");
  });
});

test("readiness SQL for Pi watches is pending-only and ignores unsuccessful terminals", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(piWatchQueueReadiness);
  expect(query.sql).toContain("finished_at IS NULL");
  expect(query.sql).toContain("lease_until");
  expect(query.sql).toContain("kind=$");
  expect(query.params).toContain("pi.watch");
  expect(query.params).toContain(PI_WATCH_MAX_ATTEMPTS);
  expect(query.sql).not.toContain("outcome");
  expect(query.sql).toContain("created_at");
  expect(query.sql).not.toContain("payload->>'createdAt'");
  expect(query.sql).not.toContain("to_timestamp");
});
