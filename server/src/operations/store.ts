import { sql } from "drizzle-orm";
import { HANDOFF_KIND } from "../agents/handoff";
import {
  PI_WATCH_KIND,
  PI_WATCH_MAX_AGE_MS,
  PI_WATCH_MAX_ATTEMPTS,
} from "../agents/pi-watch";
import type { Database } from "../db/client";
import { ROUTINE_GRACE_MS, routineAbandonedRunMs } from "../routines/timing";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

// A healthy routine worker does not prove that the separate handoff consumer is running.
// Check forwards, answer relays and failure notices alike. An active final attempt is not
// exhausted yet; queued work becomes actionable after ten minutes without a live lease.
export const handoffQueueReadiness = sql`NOT EXISTS(
  SELECT 1 FROM work_items WHERE kind=${HANDOFF_KIND} AND (
    payload->'result'->>'outcome' = 'unknown' OR (finished_at IS NULL
    AND (lease_until IS NULL OR lease_until <= now())
    AND (attempts >= ${DEFAULT_MAX_ATTEMPTS} OR run_at < now()-interval '10 minutes')))
)`;

const PI_WATCH_MAX_AGE_SECS = PI_WATCH_MAX_AGE_MS / 1000;
const PI_DELEGATION_LIMIT = 50;
const STALE_RUN_AT = sql`run_at < now()-interval '10 minutes'`;
// Age is only the row's non-null created_at. Payload timestamps are never read or
// cast: PostgreSQL AND does not short-circuit, so a text or huge jsonb number in
// payload.createdAt would throw if converted here.
const PI_WATCH_AGED = sql`created_at < now()-make_interval(secs => ${PI_WATCH_MAX_AGE_SECS})`;

// Pending Pi watches degrade health only when nothing currently holds a live lease and
// the item is exhausted, older than the 24h tracking window, or has a stale run_at.
// A live lease means a worker is polling; that is progress, not a stall.
// Terminal jobs (including access_revoked, failed, interrupted, unknown) are finished
// watch outcomes, not infrastructure failure. They must not be presented as success in
// the operations list, but they do not keep readiness degraded merely because the job
// was unsuccessful.
export const piWatchQueueReadiness = sql`NOT EXISTS(
  SELECT 1 FROM work_items WHERE kind=${PI_WATCH_KIND} AND finished_at IS NULL
    AND (lease_until IS NULL OR lease_until <= now())
    AND (attempts >= ${PI_WATCH_MAX_ATTEMPTS} OR ${STALE_RUN_AT} OR ${PI_WATCH_AGED})
)`;

export type RunRecord = {
  id: string;
  routineId: string;
  agentId: string;
  channelId: string;
  channelName: string | null;
  instruction: string;
  status: string | null;
  scheduledFor: string | null;
  startedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  replyText: string | null;
  resultMessageId: string | null;
  error: string | null;
  notificationStatus: string | null;
  notificationAttempts: number | null;
  deliveredAt: string | null;
  internalNotificationAvailable?: boolean;
  notificationDelivery?: "internal" | "telegram";
};
export type HandoffRecord = {
  id: string;
  event: string;
  at: string;
  from: string | null;
  to: string | null;
  run: string | null;
  workKey: string | null;
  resultAvailable: boolean | null;
  returnQueued: boolean | null;
  isReturn: boolean | null;
};
export type PiDelegationLifecycle =
  | "queued"
  | "watching"
  | "terminal"
  | "overdue"
  | "exhausted"
  | "unknown";
export type PiDelegationTerminalState =
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown"
  | "access_revoked"
  | "invalid_watch"
  | "executor_unavailable";
export type PiDelegationRecord = {
  key: string | null;
  executor: string | null;
  jobId: string | null;
  lifecycle: PiDelegationLifecycle;
  terminalState: PiDelegationTerminalState | null;
  attempts: number;
  runAt: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
};
export type Readiness = {
  status: "ready" | "degraded";
  checks: Record<string, boolean>;
};
export type OperationsStore = {
  runs(owner: string, id?: string): Promise<RunRecord[]>;
  handoffs(owner: string): Promise<HandoffRecord[]>;
  piDelegations(owner: string): Promise<PiDelegationRecord[]>;
  readiness(): Promise<Readiness>;
};

const PI_LIFECYCLES = [
  "queued",
  "watching",
  "terminal",
  "overdue",
  "exhausted",
  "unknown",
] as const satisfies readonly PiDelegationLifecycle[];
const PI_TERMINAL_STATES = [
  "completed",
  "failed",
  "interrupted",
  "unknown",
  "access_revoked",
  "invalid_watch",
  "executor_unavailable",
] as const satisfies readonly PiDelegationTerminalState[];
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;

function bound(value: unknown, pattern: RegExp, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 1 || value.length > max) return null;
  return pattern.test(value) ? value : null;
}

function asIso(value: unknown): string | null {
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 40) {
      const time = Date.parse(value);
      return Number.isFinite(time) ? new Date(time).toISOString() : null;
    }
  } catch {
    /* Invalid timestamps must not become a thrown health or list failure. */
  }
  return null;
}

function attemptsOf(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), 1_000_000);
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function allowlistedTerminal(
  finished: boolean,
  raw: unknown,
): PiDelegationTerminalState | null {
  if (!finished) return null;
  return typeof raw === "string" &&
    (PI_TERMINAL_STATES as readonly string[]).includes(raw)
    ? (raw as PiDelegationTerminalState)
    : "unknown";
}

function lifecycleOf(
  row: Record<string, unknown>,
  finished: boolean,
  now: number,
): PiDelegationLifecycle {
  if (finished) return "terminal";
  const leaseUntil = asIso(row.leaseUntil);
  const live =
    flag(row.liveLease) ?? (leaseUntil != null && Date.parse(leaseUntil) > now);
  if (live) return "watching";
  const attempts = attemptsOf(row.attempts);
  if (attempts >= PI_WATCH_MAX_ATTEMPTS) return "exhausted";
  const runAt = asIso(row.runAt);
  const stale =
    flag(row.staleRunAt) ??
    (runAt != null && now - Date.parse(runAt) > 10 * 60 * 1000);
  const createdAt = asIso(row.createdAt);
  const aged =
    flag(row.aged) ??
    (createdAt != null && now - Date.parse(createdAt) > PI_WATCH_MAX_AGE_MS);
  if (stale || aged) return "overdue";
  if (
    flag(row.finished) === false ||
    runAt != null ||
    bound(row.key, KEY_PATTERN, 128)
  ) {
    return "queued";
  }
  return "unknown";
}

/** Allowlisted projection: never pass through payload, result, evidence, or error text. */
export function piDelegationFromRow(
  row: unknown,
  now = Date.now(),
): PiDelegationRecord {
  const record =
    row && typeof row === "object" && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : {};
  const finishedAt = asIso(record.finishedAt);
  const finished = flag(record.finished) ?? finishedAt != null;
  const createdAt = asIso(record.createdAt);
  const lifecycle = lifecycleOf(record, finished, now);
  const terminalState =
    lifecycle === "terminal"
      ? allowlistedTerminal(true, record.resultState)
      : null;
  return {
    key: bound(record.key, KEY_PATTERN, 128),
    executor: bound(record.worker ?? record.executor, WORKER_PATTERN, 64),
    jobId: bound(record.jobId, JOB_ID_PATTERN, 32),
    lifecycle: (PI_LIFECYCLES as readonly string[]).includes(lifecycle)
      ? lifecycle
      : "unknown",
    terminalState,
    attempts: attemptsOf(record.attempts),
    runAt: asIso(record.runAt),
    createdAt,
    finishedAt,
    leaseUntil: asIso(record.leaseUntil),
  };
}

export function createOperationsStore(
  database: Database,
  historyCheck?: () => Promise<void>,
  notificationDelivery: "internal" | "telegram" = process.env
    .OPENBOT_NOTIFICATION_DELIVERY === "internal"
    ? "internal"
    : "telegram",
  computerCheck?: () => Promise<boolean>,
): OperationsStore {
  return {
    async runs(owner, id) {
      return (
        (await database.execute(sql`
        SELECT rr.id, rr.routine_id AS "routineId", r.agent_id AS "agentId", coalesce(rr.channel_id_snapshot,r.channel_id) AS "channelId",
          c.name AS "channelName", coalesce(rr.instruction_snapshot,r.instruction) AS instruction, rr.status, rr.scheduled_for AS "scheduledFor",
          rr.started_at AS "startedAt", rr.claimed_at AS "claimedAt", rr.finished_at AS "finishedAt",
          rr.reply_text AS "replyText", rr.result_message_id AS "resultMessageId", rr.error,
          n.status AS "notificationStatus", n.attempts AS "notificationAttempts", n.delivered_at AS "deliveredAt", EXISTS(SELECT 1 FROM user_notifications inbox WHERE inbox.run_id=rr.id AND inbox.owner_user_id=r.owner_user_id) AS "internalNotificationAvailable"
        FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id
        LEFT JOIN channels c ON c.id=coalesce(rr.channel_id_snapshot,r.channel_id) LEFT JOIN routine_notifications n ON n.run_id=rr.id
        WHERE r.owner_user_id=${owner} ${id ? sql`AND rr.id=${id}` : sql``}
        ORDER BY rr.started_at DESC, rr.id DESC LIMIT ${id ? 1 : 50}
      `)) as unknown as RunRecord[]
      ).map((run) => ({ ...run, notificationDelivery }));
    },
    async handoffs(owner) {
      return (await database.execute(sql`
        SELECT id, event_type AS event, created_at AS at,
          payload->>'from' AS "from", payload->>'to' AS "to", payload->>'run' AS run,
          payload->>'workKey' AS "workKey",
          payload->'resultAvailable' AS "resultAvailable", payload->'returnQueued' AS "returnQueued", payload->'isReturn' AS "isReturn"
        FROM audit_events WHERE actor_user_id=${owner} AND event_type LIKE 'agent.handoff_%'
        ORDER BY created_at DESC,id DESC LIMIT 50
      `)) as unknown as HandoffRecord[];
    },
    async piDelegations(owner) {
      const rows = (await database.execute(sql`
        SELECT key, attempts,
          run_at AS "runAt", created_at AS "createdAt", finished_at AS "finishedAt",
          lease_until AS "leaseUntil",
          CASE WHEN jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'worker') = 'string' THEN payload->>'worker' END AS worker,
          CASE WHEN jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'jobId') = 'string' THEN payload->>'jobId' END AS "jobId",
          CASE WHEN jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload->'result') = 'object'
            THEN payload->'result'->>'state' END AS "resultState",
          (finished_at IS NOT NULL) AS finished,
          (lease_until IS NOT NULL AND lease_until > now()) AS "liveLease",
          (${STALE_RUN_AT}) AS "staleRunAt",
          (${PI_WATCH_AGED}) AS aged
        FROM work_items
        WHERE kind=${PI_WATCH_KIND}
          AND jsonb_typeof(payload) = 'object'
          AND payload->>'actorId'=${owner}
        ORDER BY created_at DESC, key DESC
        LIMIT ${PI_DELEGATION_LIMIT}
      `)) as unknown as Record<string, unknown>[];
      return (Array.isArray(rows) ? rows : []).map((row) =>
        piDelegationFromRow(row),
      );
    },
    async readiness() {
      const checks: Record<string, boolean> = {
        database: false,
        scheduler: false,
        notifications: false,
        history: !historyCheck,
        handoffs: false,
        piWatches: false,
      };
      try {
        const rows = (await database.execute(sql`
          SELECT
            (NOT EXISTS(SELECT 1 FROM routines WHERE enabled) OR EXISTS(
              SELECT 1 FROM openbot_service_health WHERE name='routine-worker' AND last_ok_at > now()-interval '3 minutes')) AND NOT EXISTS(SELECT 1 FROM routines WHERE enabled AND next_run_at<now()-interval '10 minutes') AS scheduler,
            ${
              notificationDelivery === "internal"
                ? sql`(
              EXISTS(SELECT 1 FROM outbound_notification_policy WHERE singleton AND mode='internal')
              AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='gate_external_notification' AND tgrelid='routine_notifications'::regclass AND tgenabled IN ('O','A'))
              AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='routine_run_inbox' AND tgrelid='routine_runs'::regclass AND tgenabled IN ('O','A'))
              AND NOT EXISTS(SELECT 1 FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id
                WHERE rr.status IN ('succeeded','failed','skipped') AND rr.finished_at IS NOT NULL
                AND NOT EXISTS(SELECT 1 FROM user_notifications n WHERE n.run_id=rr.id AND n.owner_user_id=r.owner_user_id))
            )`
                : sql`(NOT EXISTS(SELECT 1 FROM routine_notifications WHERE status<>'sent') OR (
              EXISTS(SELECT 1 FROM openbot_service_health WHERE name='routine-notifier' AND last_ok_at > now()-interval '5 minutes')
              AND NOT EXISTS(SELECT 1 FROM routine_notifications WHERE status='failed' OR (status<>'sent' AND created_at<now()-interval '15 minutes'))))`
            } AS notifications,
            NOT EXISTS(SELECT 1 FROM routine_runs WHERE status IS NULL AND (
              (claimed_at IS NOT NULL AND claimed_at < now()-make_interval(secs => ${routineAbandonedRunMs() / 1000}))
              OR (claimed_at IS NULL AND coalesce(scheduled_for, started_at) < now()-make_interval(secs => ${ROUTINE_GRACE_MS / 1000}))
            )) AS runs,
            ${handoffQueueReadiness} AS handoffs,
            ${piWatchQueueReadiness} AS "piWatches"
        `)) as unknown as {
          scheduler: boolean;
          notifications: boolean;
          runs: boolean;
          handoffs: boolean;
          piWatches: boolean;
        }[];
        checks.database = true;
        checks.scheduler = rows[0]?.scheduler === true;
        checks.notifications = rows[0]?.notifications === true;
        checks.runs = rows[0]?.runs === true;
        checks.handoffs = rows[0]?.handoffs === true;
        checks.piWatches = rows[0]?.piWatches === true;
      } catch {
        /* Only boolean health leaves this endpoint; never database error details. */
      }
      if (computerCheck) {
        try {
          checks.computer = await computerCheck();
        } catch {
          checks.computer = false;
        }
      }
      if (historyCheck) {
        try {
          await historyCheck();
          checks.history = true;
        } catch {}
      }
      return {
        status: Object.values(checks).every(Boolean) ? "ready" : "degraded",
        checks,
      };
    },
  };
}
