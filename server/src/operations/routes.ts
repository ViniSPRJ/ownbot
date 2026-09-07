import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { OperationsStore } from "./store";

export function createOperationsRoutes(
  store: OperationsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/health", async (c) => {
    const health = await store.readiness();
    return c.json(health, health.status === "ready" ? 200 : 503);
  });
  routes.get("/runs", async (c) =>
    c.json({ runs: await store.runs(c.var.actor.id) }),
  );
  routes.get("/runs/:id", async (c) => {
    const [run] = await store.runs(c.var.actor.id, c.req.param("id"));
    return run
      ? c.json({ run })
      : c.json({ error: "Execution not found." }, 404);
  });
  routes.get("/handoffs", async (c) =>
    c.json({ handoffs: await store.handoffs(c.var.actor.id) }),
  );
  return routes;
}
