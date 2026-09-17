import { and, eq, isNull } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  acpConversationModels,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import type { AcpProvider } from "./permissions";

/**
 * Who may choose a model, and for which conversation.
 *
 * A thread id is a capability the moment it is a lookup key: anybody who can guess one could otherwise
 * change which model answers a conversation they are not in. So the thread is never taken at its word. It
 * is resolved through the mapping that created it and then through the membership that authorises the
 * channel behind it, and a selection is only honoured when both rows exist for the person asking.
 */
export type ConversationActor = {
  userId: string;
  admin: boolean;
};

export type ConversationModelSelection = {
  threadId: string;
  agentId: string;
  profileId: string;
  provider: AcpProvider;
  model: string | null;
  operatorRevision: string;
};

export type ConversationModelStore = {
  /** The channel this thread belongs to, only while the caller is still a member of it. */
  channelForThread(
    actor: ConversationActor,
    threadId: string,
  ): Promise<{ channelId: string } | undefined>;
  get(
    threadId: string,
    agentId: string,
  ): Promise<ConversationModelSelection | undefined>;
  /** Insert or replace. One conversation has one current choice per coworker. */
  set(selection: ConversationModelSelection, selectedBy: string): Promise<void>;
  clear(threadId: string, agentId: string): Promise<void>;
  /**
   * Whether this turn continued the ACP session or opened one, in the trail.
   *
   * On the store rather than on a separate audit handle because the store is already the threaded
   * thing with database access, and because this fact belongs beside the conversation it describes. It is
   * optional so a deployment without it keeps working; it is not optional in the sense of unimportant.
   * A conversation that restarted quietly is indistinguishable from one that never did, and this row is
   * the only thing that later says which.
   */
  recordTurnSession?(input: {
    threadId: string;
    agentId: string;
    actorUserId: string | null;
    resumed: boolean;
    freshReason?: string;
    /** Requested selection; kept for readers of the legacy `model` field. */
    model: string | null;
    requestedModel: string | null;
    /** Confirmed effective id, or null when the CLI did not report one. */
    resolvedModel: string | null;
    executor: "acp";
    runId: string;
    provider: string;
    profileId: string;
  }): Promise<void>;
};

const providers: readonly AcpProvider[] = ["codex", "claude", "grok", "pi"];

function asProvider(value: unknown): AcpProvider {
  return providers.includes(value as AcpProvider)
    ? (value as AcpProvider)
    : "codex";
}

export function createConversationModelStore(
  database: Database,
  auditStore: AuditStore,
): ConversationModelStore {
  return {
    async channelForThread(actor, threadId) {
      const rows = await database
        .select({ channelId: intelligenceChannelMappings.channelId })
        .from(intelligenceChannelMappings)
        .innerJoin(
          channelMemberships,
          and(
            eq(
              channelMemberships.channelId,
              intelligenceChannelMappings.channelId,
            ),
            eq(channelMemberships.userId, intelligenceChannelMappings.userId),
          ),
        )
        .innerJoin(
          channels,
          and(
            eq(channels.id, intelligenceChannelMappings.channelId),
            isNull(channels.deletedAt),
          ),
        )
        .where(
          and(
            eq(intelligenceChannelMappings.threadId, threadId),
            // An administrator reads the trail, they do not join the conversation. Membership still
            // decides for everybody, including them, so this stays the single answer to one question.
            actor.admin
              ? undefined
              : eq(intelligenceChannelMappings.userId, actor.userId),
          ),
        )
        .limit(1);
      return rows[0] ? { channelId: rows[0].channelId } : undefined;
    },

    async get(threadId, agentId) {
      const rows = await database
        .select()
        .from(acpConversationModels)
        .where(
          and(
            eq(acpConversationModels.threadId, threadId),
            eq(acpConversationModels.agentId, agentId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return;
      return {
        threadId: row.threadId,
        agentId: row.agentId,
        profileId: row.profileId,
        provider: asProvider(row.provider),
        model: row.model,
        operatorRevision: row.operatorRevision,
      };
    },

    async set(selection, selectedBy) {
      await database
        .insert(acpConversationModels)
        .values({
          threadId: selection.threadId,
          agentId: selection.agentId,
          ownerUserId: selectedBy,
          profileId: selection.profileId,
          provider: selection.provider,
          model: selection.model,
          operatorRevision: selection.operatorRevision,
          selectedBy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            acpConversationModels.threadId,
            acpConversationModels.agentId,
          ],
          set: {
            profileId: selection.profileId,
            provider: selection.provider,
            model: selection.model,
            operatorRevision: selection.operatorRevision,
            selectedBy,
            updatedAt: new Date(),
          },
        });
    },

    async clear(threadId, agentId) {
      await database
        .delete(acpConversationModels)
        .where(
          and(
            eq(acpConversationModels.threadId, threadId),
            eq(acpConversationModels.agentId, agentId),
          ),
        );
    },

    /**
     * Written straight into the trail, not into a table of its own.
     *
     * The questions people ask of this data are trail questions — "did the model that answered this
     * conversation have its own history in front of it, on this turn" — and a second place to look is a
     * second place to forget. The redaction in audit.ts already drops anything that looks like content.
     */
    async recordTurnSession(input) {
      await recordAuditEvent(auditStore, {
        eventType: input.resumed ? "session.resumed" : "session.started",
        targetType: "thread",
        targetId: input.threadId,
        actorUserId: input.actorUserId ?? undefined,
        payload: {
          agentId: input.agentId,
          provider: input.provider,
          profileId: input.profileId,
          model: input.model,
          requestedModel: input.requestedModel,
          resolvedModel: input.resolvedModel,
          executor: input.executor,
          runId: input.runId,
          ...(input.resumed
            ? {}
            : { reason: input.freshReason ?? "first_turn" }),
        },
      }).catch(() => {});
    },
  };
}

/**
 * The model a run should answer with, or undefined to leave the operator's choice standing.
 *
 * Two conditions, both of which have to hold. The person is still a member of the channel the thread
 * belongs to, and the operator configuration has not moved since the selection was validated. A selection
 * made against a replaced catalogue is a choice about a model the CLI may no longer offer, so it is
 * dropped rather than attempted — the run then answers on the operator's default, and `dropped` says why
 * the interface is showing something other than what was last picked.
 */
export async function resolveConversationModel(input: {
  store: ConversationModelStore;
  actor: ConversationActor;
  threadId: string;
  agentId: string;
  /** The operator mapping currently in force for this coworker. */
  current: { profileId: string; revision: string };
}): Promise<{ model: string | null } | { dropped: "membership" | "stale" }> {
  const membership = await input.store.channelForThread(
    input.actor,
    input.threadId,
  );
  if (!membership) return { dropped: "membership" };
  const stored = await input.store.get(input.threadId, input.agentId);
  if (!stored) return { model: null };
  if (stored.operatorRevision !== input.current.revision)
    return { dropped: "stale" };
  // A selection recorded against a different connection cannot be honoured on this one: the same model
  // id can name two different things on two CLIs.
  if (stored.profileId !== input.current.profileId) return { dropped: "stale" };
  return { model: stored.model };
}
