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
};
export type HandoffStatusReader = (
  from: RunAssertion,
  jobId: string,
) => Promise<HandoffStatus | null>;

/** A bot may inspect only work it sent for this actor in this conversation. */
export function createHandoffStatusReader(
  database: Database,
): HandoffStatusReader {
  return async (from, jobId) => {
    if (!from.threadId) return null;
    const rows = await database.execute(sql`
      SELECT w.key AS "jobId",
        CASE WHEN w.finished_at IS NOT NULL THEN 'completed'
          WHEN w.claimed_by IS NOT NULL AND w.lease_until > now() THEN 'running'
          WHEN w.attempts >= 5 THEN 'failed'
          WHEN w.attempts > 0 THEN 'retry_pending' ELSE 'queued' END AS status,
        w.payload->'result'->>'answer' AS answer,
        CASE WHEN r.finished_at IS NOT NULL THEN 'processed'
          WHEN r.claimed_by IS NOT NULL AND r.lease_until > now() THEN 'running'
          WHEN r.attempts >= 5 THEN 'failed'
          WHEN r.key IS NOT NULL THEN 'queued' ELSE NULL END AS "returnStatus"
      FROM work_items w LEFT JOIN work_items r ON r.kind=w.kind AND r.key='relay:' || w.key
      WHERE w.kind='bot.message' AND w.key=${jobId}
        AND w.payload->>'actorId'=${from.actorId}
        AND w.payload->>'fromBotId'=${from.botId}
        AND w.payload->>'threadId'=${from.threadId}
        AND NOT (w.payload ? 'answerIn')
      LIMIT 1
    `);
    return (rows[0] as unknown as HandoffStatus | undefined) ?? null;
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
      "Read the durable status and saved answer of a job you delegated in this conversation. Use its exact Job ID. Results normally return automatically; do not poll in a loop. Completed means the recipient turn finished, not that every requested action succeeded. Return processed means the coordinator turn ran. Records expire after 24 hours; missing is not proof of failure.",
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
