import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  parsePushSubscription,
  pushEndpointAllowed,
  type VapidConfig,
} from "./push-config";
import {
  type PushStore,
  PushSubscriptionConflict,
  PushSubscriptionLimit,
} from "./push-store";

export function createPushRoutes(
  store: Pick<PushStore, "list" | "subscribe" | "unsubscribe">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  config: () => VapidConfig | null,
  options: { allowedOrigins?: string[] } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use(
    "*",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "Inscrição muito grande." }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    // Protect cookie-authenticated opt-in/out from cross-site form/fetch requests.
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const allowed = options.allowedOrigins ?? [new URL(c.req.url).origin];
      if (site === "cross-site" || (origin && !allowed.includes(origin)))
        return c.json({ error: "Origem recusada." }, 403);
      if (
        !c.req
          .header("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        return c.json({ error: "Envie JSON." }, 415);
      if (Number(c.req.header("content-length") ?? 0) > 4096)
        return c.json({ error: "Inscrição muito grande." }, 413);
    }
    await next();
  });
  app.get("/", async (c) => {
    const active = config();
    return c.json({
      push: {
        enabled: !!active,
        publicKey: active?.publicKey ?? null,
        subscriptions: await store.list(c.var.actor.id),
      },
    });
  });
  async function body(c: {
    req: { text: () => Promise<string> };
  }): Promise<unknown> {
    const raw = await c.req.text();
    return raw.length <= 4096 ? JSON.parse(raw) : null;
  }
  app.post("/subscriptions", async (c) => {
    const active = config();
    if (!active)
      return c.json({ error: "Notificações push não configuradas." }, 503);
    const parsed = parsePushSubscription(await body(c).catch(() => null));
    if (!parsed) return c.json({ error: "Inscrição push inválida." }, 400);
    try {
      return c.json({
        ok: true,
        id: await store.subscribe(c.var.actor.id, parsed, active.publicKey),
      });
    } catch (error) {
      if (error instanceof PushSubscriptionConflict)
        return c.json(
          { error: "Este dispositivo está vinculado a outra conta." },
          409,
        );
      if (error instanceof PushSubscriptionLimit)
        return c.json({ error: "Limite de dispositivos atingido." }, 409);
      throw error;
    }
  });
  app.delete("/subscriptions", async (c) => {
    const parsed = await body(c).catch(() => null);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !("endpoint" in parsed) ||
      typeof parsed.endpoint !== "string" ||
      !pushEndpointAllowed(parsed.endpoint)
    )
      return c.json({ error: "Informe um endpoint push válido." }, 400);
    await store.unsubscribe(c.var.actor.id, parsed.endpoint);
    return c.json({ ok: true });
  });
  return app;
}
