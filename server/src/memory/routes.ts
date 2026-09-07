import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { BotAccessCheck } from "../agents/profile-policy";
import { parseMemoryInput, type AgentMemoryStore } from "./store";

export function createAgentMemoryRoutes(
  store: AgentMemoryStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canAccess: BotAccessCheck,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.use("/:agentId", async (c, next) => {
    if (!(await canAccess(c.var.actor, c.req.param("agentId")!)))
      return c.json({ error: "Bot not found." }, 404);
    await next();
  });
  routes.get("/:agentId", async (c) =>
    c.json({
      memory: await store.read(c.var.actor.id, c.req.param("agentId")),
    }),
  );
  routes.put("/:agentId", async (c) => {
    const input = parseMemoryInput(await c.req.json().catch(() => null));
    if (!input)
      return c.json(
        {
          error:
            "Provide standingInstructions and notes (up to 6000 characters each) and expectedRevision.",
        },
        400,
      );
    const memory = await store.write(
      c.var.actor.id,
      c.req.param("agentId"),
      input,
    );
    return memory
      ? c.json({ memory })
      : c.json({ error: "Memory changed. Reload before saving." }, 409);
  });
  return routes;
}
