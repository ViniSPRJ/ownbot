import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AuditReader, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { isPrivateAgent } from "../privacy/policy";
import { acpModelSelectionFor } from "./config";
import type { ConversationModelStore } from "./conversation-models";
import { discoverAcpModels, type ModelCatalogue } from "./models";

/**
 * Choosing a model for one conversation.
 *
 * `/:agentId/acp-models` is the administrator's page: it edits the operator's file and changes what that
 * role answers with everywhere. This is the other thing. A person in Cowork picks a model for the task in
 * front of them, in this conversation, and the rest of the deployment does not move.
 *
 * What a caller may send is one field: `model`. The connection comes from the operator's mapping, never
 * from here. An executable path, an argument list or an environment is not a choice a browser gets to
 * make, and the reason that has to be said out loud is that the model catalogue arrives from a CLI which
 * an operator installed and could have influenced.
 *
 * `/:threadId/acp-session/:agentId` is the other half: what the last turn did with the CLI's session. It
 * reads the trail rather than a table, because the trail is where that fact is written and a second copy
 * is a second thing to go stale.
 */
export function createAcpConversationModelRoutes(
  store: AgentProfileStore,
  conversations: ConversationModelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  /** Reads the session rows back. Absent means the session endpoint answers "nothing recorded". */
  auditReader?: AuditReader,
  discover: typeof discoverAcpModels = discoverAcpModels,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** Membership is the whole of the authorisation, so it is resolved before anything is read. */
  async function authorize(c: Context<{ Variables: AppVariables }>) {
    const actor = {
      userId: c.var.actor.id,
      admin: c.var.actor.role === "admin",
    };
    const threadId = c.req.param("threadId");
    const agentId = c.req.param("agentId");
    if (!threadId || !agentId) return { error: 404 as const };
    const agent = await store.get(c.var.actor, agentId);
    if (!agent || agent.deletedAt) return { error: 404 as const };
    if (isPrivateAgent(agentId))
      return {
        error: 409 as const,
        message: "Este coworker usa o runtime privado.",
      };
    const membership = await conversations.channelForThread(actor, threadId);
    if (!membership) return { error: 403 as const };
    const selection = acpModelSelectionFor(agentId);
    if (!selection)
      return {
        error: 409 as const,
        message: "Este coworker não está configurado para ACP.",
      };
    return { actor, threadId, agentId, selection };
  }

  routes.get("/:threadId/acp-model/:agentId", requireUser, async (c) => {
    const authorized = await authorize(c);
    if ("error" in authorized)
      return c.json(
        { error: authorized.message ?? "Não autorizado." },
        authorized.error,
      );
    try {
      const catalogue = await discover(authorized.selection.profile);
      const stored = await conversations.get(
        authorized.threadId,
        authorized.agentId,
      );
      // The person's choice wins over the operator's default only while it is still admissible, and the
      // reason it is not travels with the response: the interface must not show a pick that is not running.
      const honoured =
        stored &&
        stored.profileId === authorized.selection.profile.profileId &&
        stored.operatorRevision === authorized.selection.revision
          ? stored.model
          : null;
      return c.json({
        selection: {
          models: catalogue.models,
          currentModel: catalogue.currentModel,
          operatorDefault: authorized.selection.defaultModel,
          selected: honoured,
          // Says out loud when a stored choice has been dropped, so the interface cannot imply a choice
          // that the runtime is not honouring.
          dropped:
            stored && honoured === null && stored.model !== null
              ? stored.operatorRevision !== authorized.selection.revision
                ? "stale"
                : "connection_changed"
              : null,
          revision: authorized.selection.revision,
          canSelect: true,
        },
      });
    } catch {
      return c.json(
        { error: "Não foi possível consultar os modelos desta CLI." },
        503,
      );
    }
  });

  /**
   * What the last turn did with this coworker's session, for the person reading the conversation.
   *
   * A conversation that quietly restarted looks exactly like one that never did: the thread is all
   * there, the answer arrived, and only the CLI knows it had never heard of any of it. That is the one
   * state worth surfacing, so this exists to be read beside the transcript rather than in the trail by
   * an administrator who was not the one confused.
   *
   * Bounded on purpose. One thread can hold several coworkers, so the newest session row for the thread
   * is not necessarily this coworker's, and the window is wide enough to step over the other coworkers'
   * turns without paging the trail from a conversation view. A coworker that has not answered inside it
   * reads as nothing recorded, which is what the interface shows for a first turn anyway.
   */
  routes.get("/:threadId/acp-session/:agentId", requireUser, async (c) => {
    const authorized = await authorize(c);
    if ("error" in authorized)
      return c.json(
        { error: authorized.message ?? "Não autorizado." },
        authorized.error,
      );
    if (!auditReader) return c.json({ session: null });
    let events: Awaited<ReturnType<AuditReader["list"]>>["events"];
    try {
      ({ events } = await auditReader.list({
        limit: 20,
        eventType: "session.resumed,session.started",
        targetType: "thread",
        targetId: authorized.threadId,
      }));
    } catch {
      // The transcript is readable without this. A trail that cannot be read is not a reason to refuse
      // the conversation, so it reads as nothing recorded.
      return c.json({ session: null });
    }
    const latest = events.find(
      (event) => event.payload.agentId === authorized.agentId,
    );
    if (!latest) return c.json({ session: null });
    const reason = latest.payload.reason;
    return c.json({
      session: {
        resumed: latest.eventType === "session.resumed",
        reason: typeof reason === "string" ? reason : null,
        model: typeof latest.payload.model === "string" ? latest.payload.model : null,
        provider:
          typeof latest.payload.provider === "string"
            ? latest.payload.provider
            : "codex",
        at: latest.createdAt,
      },
    });
  });

  routes.put("/:threadId/acp-model/:agentId", requireUser, async (c) => {
    const authorized = await authorize(c);
    if ("error" in authorized)
      return c.json(
        { error: authorized.message ?? "Não autorizado." },
        authorized.error,
      );
    const body = await c.req.json().catch(() => null);
    const model =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).model
        : undefined;
    const revision =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).revision
        : undefined;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      // `model` and `revision`, nothing else. An extra key is a caller trying to send more than this route takes.
      Object.keys(body).some((key) => !["model", "revision"].includes(key)) ||
      !(
        model === null ||
        (typeof model === "string" && model.length > 0 && model.length <= 256)
      ) ||
      typeof revision !== "string"
    )
      return c.json({ error: "Selecione um modelo válido." }, 400);
    if (revision !== authorized.selection.revision)
      return c.json(
        { error: "A configuração mudou. Atualize a lista antes de escolher." },
        409,
      );
    let catalogue: ModelCatalogue;
    try {
      catalogue = await discover(authorized.selection.profile);
    } catch {
      return c.json(
        { error: "Não foi possível consultar os modelos desta CLI." },
        503,
      );
    }
    if (model !== null && !catalogue.models.some((entry) => entry.id === model))
      return c.json(
        { error: "Este modelo não está disponível nesta CLI." },
        400,
      );
    try {
      await conversations.set(
        {
          threadId: authorized.threadId,
          agentId: authorized.agentId,
          profileId: authorized.selection.profile.profileId,
          provider: authorized.selection.profile.provider ?? "codex",
          model: model === null ? null : model,
          operatorRevision: authorized.selection.revision,
        },
        c.var.actor.id,
      );
    } catch {
      return c.json({ error: "Não foi possível salvar a escolha." }, 503);
    }
    if (auditStore)
      await recordAuditEvent(auditStore, {
        eventType: "session.model_changed",
        targetType: "thread",
        targetId: authorized.threadId,
        actorUserId: c.var.actor.id,
        payload: {
          agentId: authorized.agentId,
          provider: authorized.selection.profile.provider ?? "codex",
          profileId: authorized.selection.profile.profileId,
          from: catalogue.currentModel,
          to: model === null ? authorized.selection.defaultModel : model,
          explicit: model !== null,
        },
      }).catch(() => {});
    return c.json({ saved: true, model: model === null ? null : model });
  });

  return routes;
}
