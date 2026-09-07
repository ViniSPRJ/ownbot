import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { NotificationsStore } from "./store";

export function createNotificationsRoutes(
  store: NotificationsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.get("/", async (c) => {
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      return c.json({ error: "Página inválida." }, 400);
    return c.json({ inbox: await store.list(c.var.actor.id, offset) });
  });
  app.post("/:id/read", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.read !== "boolean")
      return c.json({ error: "Informe se a notificação foi lida." }, 400);
    const found = await store.setRead(
      c.var.actor.id,
      c.req.param("id"),
      body.read,
    );
    return found
      ? c.json({ ok: true })
      : c.json({ error: "Notificação não encontrada." }, 404);
  });
  return app;
}
