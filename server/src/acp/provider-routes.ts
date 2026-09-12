import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { isPrivateAgent } from "../privacy/policy";
import {
  acpProviderSelectionFor,
  configuredAcpProfile,
  saveAcpAgentProvider,
  type AcpProfile,
} from "./config";
import { discoverAcpModels, type ModelCatalogue } from "./models";

/** Administrator settings for mapped agents; commands and credentials remain operator-owned. */
export function createAcpProviderRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  discover: (
    profile: AcpProfile,
  ) => Promise<ModelCatalogue> = discoverAcpModels,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("/:agentId/acp-providers", requireUser, async (c, next) => {
    if (c.var.actor.role !== "admin")
      return c.json(
        { error: "Somente o administrador pode selecionar a CLI." },
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
  routes.get("/:agentId/acp-providers", (c) => {
    try {
      const selection = acpProviderSelectionFor(c.req.param("agentId"));
      if (!selection)
        return c.json(
          { error: "Este agente não está configurado para ACP." },
          409,
        );
      return c.json({ selection });
    } catch {
      return c.json(
        { error: "Não foi possível consultar as conexões ACP." },
        503,
      );
    }
  });
  routes.put("/:agentId/acp-providers", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["profileId", "revision"].includes(key),
      ) ||
      typeof body.profileId !== "string" ||
      !body.profileId ||
      body.profileId.length > 256 ||
      typeof body.revision !== "string"
    )
      return c.json({ error: "Selecione uma conexão válida." }, 400);
    const id = c.req.param("agentId");
    try {
      const selection = acpProviderSelectionFor(id);
      if (!selection || selection.revision !== body.revision)
        return c.json(
          { error: "A configuração mudou. Atualize a lista antes de salvar." },
          409,
        );
      const profile = configuredAcpProfile(body.profileId);
      if (!profile)
        return c.json(
          { error: "Esta conexão não está configurada pelo administrador." },
          400,
        );
      // Confirm a bounded ACP session can start before accepting this connection.
      await discover(profile);
      // Discovery is asynchronous: recheck both revision and live authorization before saving.
      const agent = await store.get(c.var.actor, id);
      if (!agent || agent.deletedAt)
        return c.json({ error: "Agente não encontrado." }, 404);
      if (isPrivateAgent(id))
        return c.json({ error: "Este agente usa o runtime privado." }, 409);
      if (acpProviderSelectionFor(id)?.revision !== body.revision)
        return c.json(
          { error: "A configuração mudou. Atualize a lista antes de salvar." },
          409,
        );
      saveAcpAgentProvider(id, body.profileId, body.revision);
      if (auditStore && selection.profileId !== body.profileId)
        await recordAuditEvent(auditStore, {
          eventType: "bot.updated",
          targetType: "agent",
          targetId: id,
          actorUserId: c.var.actor.id,
          payload: {
            setting: "acp.provider",
            previousProfile: selection.profileId,
            profile: body.profileId,
            provider: profile.provider ?? "codex",
          },
        }).catch(() => {});
      return c.json({ saved: true });
    } catch {
      return c.json(
        {
          error:
            "Não foi possível conectar à CLI. Verifique o login e tente novamente.",
        },
        503,
      );
    }
  });
  return routes;
}
