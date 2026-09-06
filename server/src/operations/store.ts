import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

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
};
export type HandoffRecord = {
  id: string;
  event: string;
  at: string;
  from: string | null;
  to: string | null;
  run: string | null;
  workKey: string | null;
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
): OperationsStore {
  return {
    async runs(owner, id) {
      return (await database.execute(sql`
        SELECT rr.id, rr.routine_id AS "routineId", r.agent_id AS "agentId", coalesce(rr.channel_id_snapshot,r.channel_id) AS "channelId",
          c.name AS "channelName", coalesce(rr.instruction_snapshot,r.instruction) AS instruction, rr.status, rr.scheduled_for AS "scheduledFor",
          rr.started_at AS "startedAt", rr.claimed_at AS "claimedAt", rr.finished_at AS "finishedAt",
          rr.reply_text AS "replyText", rr.result_message_id AS "resultMessageId", rr.error,
          n.status AS "notificationStatus", n.attempts AS "notificationAttempts", n.delivered_at AS "deliveredAt"
        FROM routine_runs rr JOIN routines r ON r.id=rr.routine_id
        LEFT JOIN channels c ON c.id=coalesce(rr.channel_id_snapshot,r.channel_id) LEFT JOIN routine_notifications n ON n.run_id=rr.id
        WHERE r.owner_user_id=${owner} ${id ? sql`AND rr.id=${id}` : sql``}
        ORDER BY rr.started_at DESC, rr.id DESC LIMIT ${id ? 1 : 50}
      `)) as unknown as RunRecord[];
    },
    async handoffs(owner) {
      return (await database.execute(sql`
        SELECT id, event_type AS event, created_at AS at,
          payload->>'from' AS "from", payload->>'to' AS "to", payload->>'run' AS run,
          payload->>'workKey' AS "workKey"
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
      };
      try {
        const rows = (await database.execute(sql`
          SELECT
            (NOT EXISTS(SELECT 1 FROM routines WHERE enabled) OR EXISTS(
              SELECT 1 FROM openbot_service_health WHERE name='routine-worker' AND last_ok_at > now()-interval '3 minutes')) AND NOT EXISTS(SELECT 1 FROM routines WHERE enabled AND next_run_at<now()-interval '10 minutes') AS scheduler,
            (NOT EXISTS(SELECT 1 FROM routine_notifications WHERE status<>'sent') OR (
              EXISTS(SELECT 1 FROM openbot_service_health WHERE name='routine-notifier' AND last_ok_at > now()-interval '5 minutes')
              AND NOT EXISTS(SELECT 1 FROM routine_notifications WHERE status='failed' OR (status<>'sent' AND created_at<now()-interval '15 minutes')))) AS notifications,
            NOT EXISTS(SELECT 1 FROM routine_runs WHERE status IS NULL AND started_at<now()-interval '11 minutes') AS runs
        `)) as unknown as {
          scheduler: boolean;
          notifications: boolean;
          runs: boolean;
        }[];
        checks.database = true;
        checks.scheduler = rows[0]?.scheduler === true;
        checks.notifications = rows[0]?.notifications === true;
        checks.runs = rows[0]?.runs === true;
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
