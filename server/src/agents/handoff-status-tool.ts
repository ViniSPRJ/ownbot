import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";

export type HandoffStatus = {
  jobId: string;
  status: string;
  answer: string | null;
  returnStatus: string | null;
  /** Present only when the durable result recorded a reconciliation. */
  resolution?: string;
};

export type HandoffStatusReader = (
  from: RunAssertion,
  jobId: string,
) => Promise<HandoffStatus | null>;

/** Matches the queue attempt cap used by `handoffStatusReader` SQL. */
const HANDOFF_ATTEMPT_CAP = 5;

type Lifecycle = {
  outcome: string | null | undefined;
  finished: boolean;
  running: boolean;
  attempts: number;
};

/**
 * Outcome is inspected before `finished_at`. An admitted hop whose delivery was
 * not confirmed stays unknown even though the row is finished; a later operator
 * archive is reconciled, not completed. Completed still means the recipient turn
 * finished with a normal result.
 */
export function mapHandoffWorkStatus(row: Lifecycle): string {
  if (row.outcome === "unknown") return "unknown";
  if (row.outcome === "reconciled") return "reconciled";
  if (row.finished) return "completed";
  if (row.running) return "running";
  if (row.attempts >= HANDOFF_ATTEMPT_CAP) return "failed";
  if (row.attempts > 0) return "retry_pending";
  return "queued";
}

/**
 * The same outcome-first rule as the hop itself. A finished relay with
 * `outcome=unknown` is unknown, never processed.
 */
export function mapHandoffReturnStatus(
  row: Lifecycle & { present: boolean },
): string | null {
  if (!row.present) return null;
  if (row.outcome === "unknown") return "unknown";
  if (row.outcome === "reconciled") return "reconciled";
  if (row.finished) return "processed";
  if (row.running) return "running";
  if (row.attempts >= HANDOFF_ATTEMPT_CAP) return "failed";
  return "queued";
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function asAttempts(value: unknown): number {
  const attempts = Number(value);
  return Number.isFinite(attempts) ? attempts : 0;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A bot may inspect only work it sent for this actor in this conversation. */
export function createHandoffStatusReader(
  database: Database,
): HandoffStatusReader {
  return async (from, jobId) => {
    if (!from.threadId) return null;
    const rows = await database.execute(sql`
      SELECT w.key AS "jobId",
        w.payload->'result'->>'outcome' AS outcome,
        w.payload->'result'->>'answer' AS answer,
        w.payload->'result'->>'resolution' AS resolution,
        w.finished_at IS NOT NULL AS finished,
        (w.claimed_by IS NOT NULL AND w.lease_until > now()) AS running,
        w.attempts AS attempts,
        r.key IS NOT NULL AS "relayPresent",
        r.payload->'result'->>'outcome' AS "relayOutcome",
        r.finished_at IS NOT NULL AS "relayFinished",
        (r.claimed_by IS NOT NULL AND r.lease_until > now()) AS "relayRunning",
        COALESCE(r.attempts, 0) AS "relayAttempts"
      FROM work_items w LEFT JOIN work_items r ON r.kind=w.kind AND r.key='relay:' || w.key
      WHERE w.kind='bot.message' AND w.key=${jobId}
        AND w.payload->>'actorId'=${from.actorId}
        AND w.payload->>'fromBotId'=${from.botId}
        AND w.payload->>'threadId'=${from.threadId}
        AND NOT (w.payload ? 'answerIn')
      LIMIT 1
    `);
    const row = rows[0] as
      | {
          jobId: string;
          outcome?: string | null;
          answer?: string | null;
          resolution?: string | null;
          finished?: unknown;
          running?: unknown;
          attempts?: unknown;
          relayPresent?: unknown;
          relayOutcome?: string | null;
          relayFinished?: unknown;
          relayRunning?: unknown;
          relayAttempts?: unknown;
        }
      | undefined;
    if (!row) return null;
    const status: HandoffStatus = {
      jobId: row.jobId,
      status: mapHandoffWorkStatus({
        outcome: row.outcome,
        finished: asBool(row.finished),
        running: asBool(row.running),
        attempts: asAttempts(row.attempts),
      }),
      answer: asText(row.answer),
      returnStatus: mapHandoffReturnStatus({
        present: asBool(row.relayPresent),
        outcome: row.relayOutcome,
        finished: asBool(row.relayFinished),
        running: asBool(row.relayRunning),
        attempts: asAttempts(row.relayAttempts),
      }),
    };
    const resolution = asText(row.resolution);
    if (resolution) status.resolution = resolution;
    return status;
  };
}

export function handoffStatusTool(
  reader: HandoffStatusReader,
  from: RunAssertion,
): GrantedTool {
  const parameters = z.object({ jobId: z.string().min(1).max(200) });
  return {
    name: "handoff_status",
    ref: "bot/handoff_status",
    description:
      "Read the durable status and saved answer of a job you delegated in this conversation. Use its exact Job ID. Results normally return automatically; do not poll in a loop. Completed means the recipient turn finished, not that every requested action succeeded. Unknown means delivery was not confirmed. Reconciled is an operator archive of that unknown record, not proof of delivery. Return processed means the coordinator turn ran. Records expire after 24 hours; missing is not proof of failure.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success)
        return "Supply the exact Job ID returned by message_bot.";
      const status = await reader(from, parsed.data.jobId);
      return status
        ? JSON.stringify(status)
        : "Job not found in this conversation, or its retention window expired.";
    },
  };
}
