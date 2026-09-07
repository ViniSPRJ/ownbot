import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { HANDOFF_KIND } from "../agents/handoff";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

// A healthy routine worker does not prove that the separate handoff consumer is running.
// Check forwards, answer relays and failure notices alike. An active final attempt is not
// exhausted yet; queued work becomes actionable after ten minutes without a live lease.
export const handoffQueueReadiness = sql`NOT EXISTS(
  SELECT 1 FROM work_items WHERE kind=${HANDOFF_KIND} AND finished_at IS NULL
  AND (lease_until IS NULL OR lease_until <= now())
  AND (attempts >= ${DEFAULT_MAX_ATTEMPTS} OR run_at < now()-interval '10 minutes')
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
export type Readiness = {
  status: "ready" | "degraded";
  checks: Record<string, boolean>;
};
export type OperationsStore = {
  runs(owner: string, id?: string): Promise<RunRecord[]>;
  handoffs(owner: string): Promise<HandoffRecord[]>;
  readiness(): Promise<Readiness>;
};

export function createOperationsStore(
  database: Database,
  historyCheck?: () => Promise<void>,
  notificationDelivery: "internal" | "telegram" = process.env
    .OPENBOT_NOTIFICATION_DELIVERY === "internal"
    ? "internal"
    : "telegram",
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
    async readiness() {
      const checks: Record<string, boolean> = {
        database: false,
        scheduler: false,
        notifications: false,
        history: !historyCheck,
        handoffs: false,
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
            NOT EXISTS(SELECT 1 FROM routine_runs WHERE status IS NULL AND started_at<now()-interval '11 minutes') AS runs,
            ${handoffQueueReadiness} AS handoffs
        `)) as unknown as {
          scheduler: boolean;
          notifications: boolean;
          runs: boolean;
          handoffs: boolean;
        }[];
        checks.database = true;
        checks.scheduler = rows[0]?.scheduler === true;
        checks.notifications = rows[0]?.notifications === true;
        checks.runs = rows[0]?.runs === true;
        checks.handoffs = rows[0]?.handoffs === true;
      } catch {
        /* Only boolean health leaves this endpoint; never database error details. */
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
