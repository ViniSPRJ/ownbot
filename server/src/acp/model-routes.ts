import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { isPrivateAgent } from "../privacy/policy";
import {
  acpModelSelectionFor,
  saveAcpAgentModel,
  type AcpProfile,
} from "./config";
import { discoverAcpModels, type ModelCatalogue } from "./models";

export function createAcpModelRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  discover: (
    profile: AcpProfile,
  ) => Promise<ModelCatalogue> = discoverAcpModels,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("/:agentId/acp-models", requireUser, async (c, next) => {
    if (c.var.actor.role !== "admin")
      return c.json(
        { error: "Somente o administrador pode selecionar modelos das CLIs." },
        403,
      );
    const id = c.req.param("agentId")!;
    const agent = await store.get(c.var.actor, id);
    if (!agent || agent.deletedAt)
      return c.json({ error: "Agente não encontrado." }, 404);
    if (isPrivateAgent(id))
      return c.json({ error: "Este agente usa o runtime privado." }, 409);
    return next();
  });
  routes.get("/:agentId/acp-models", async (c) => {
    try {
      const selection = acpModelSelectionFor(c.req.param("agentId"));
      if (!selection)
        return c.json(
          { error: "Este agente não está configurado para ACP." },
          409,
        );
      const catalogue = await discover(selection.profile);
      return c.json({
        selection: {
          ...catalogue,
          selectedModel: selection.selectedModel,
          defaultModel: selection.defaultModel,
          revision: selection.revision,
        },
      });
    } catch {
      return c.json(
        {
          error:
            "Não foi possível consultar os modelos. Verifique o login e a disponibilidade da CLI.",
        },
        503,
      );
    }
  });
  routes.put("/:agentId/acp-models", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["model", "revision"].includes(key)) ||
      !(
        body.model === null ||
        (typeof body.model === "string" &&
          body.model.length > 0 &&
          body.model.length <= 256)
      ) ||
      typeof body.revision !== "string"
    )
      return c.json({ error: "Selecione um modelo válido." }, 400);
    const id = c.req.param("agentId");
    try {
      const selection = acpModelSelectionFor(id);
      if (!selection || selection.revision !== body.revision)
        return c.json(
          { error: "A configuração mudou. Atualize a lista antes de salvar." },
          409,
        );
      if (body.model !== null) {
        const catalogue = await discover(selection.profile);
        if (!catalogue.models.some((model) => model.id === body.model))
          return c.json(
            { error: "Este modelo não está disponível na CLI." },
            400,
          );
      }
      // Rechecks the revision after asynchronous discovery; no other agent's edit can be lost.
      saveAcpAgentModel(id, body.model, body.revision);
      if (auditStore)
        await recordAuditEvent(auditStore, {
          eventType: "bot.updated",
          targetType: "agent",
          targetId: id,
          actorUserId: c.var.actor.id,
          payload: {
            setting: "acp.model",
            model: body.model,
            provider: selection.profile.provider ?? "codex",
          },
        }).catch(() => {});
      return c.json({ saved: true });
    } catch {
      return c.json(
        {
          error:
            "Não foi possível salvar. Atualize os modelos e tente novamente.",
        },
        503,
      );
    }
  });
  return routes;
}
