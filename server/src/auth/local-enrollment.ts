import { createHash, timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { accounts, users, userRoles } from "../db/schema";

export function validEnrollmentToken(token: unknown, expectedHash?: string): boolean {
  if (typeof token !== "string" || token.length < 32 || token.length > 256 || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}

/** A single operator enrollment, preserving the ID and email owning existing private resources. */
export function createLocalEnrollmentRoutes(
  database: Database,
  auth: { handler: (request: Request) => Promise<Response> },
  config: DeploymentConfig,
) {
  const routes = new Hono();
  routes.post("/enroll", async (context) => {
    if (!config.auth?.localPassword) return context.json({ error: "Unavailable" }, 404);
    const origin = context.req.header("origin");
    const allowed = new Set([new URL(config.auth.baseUrl).origin, ...config.auth.trustedOrigins]);
    if (!origin || !allowed.has(origin)) return context.json({ error: "Forbidden" }, 403);
    // The unguessable token is an enrollment capability, never a reusable login credential.
    let body: { token?: unknown; password?: unknown };
    try { body = await context.req.json(); } catch { return context.json({ error: "Invalid request" }, 400); }
    if (!validEnrollmentToken(body.token, config.auth.localEnrollmentTokenHash)) return context.json({ error: "Invalid enrollment" }, 403);
    if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) return context.json({ error: "Use uma senha de 12 a 128 caracteres." }, 400);
    const password = body.password;
    const hashed = await hashPassword(password);
    const email = await database.transaction(async (tx) => {
      // Lock the existing owner so concurrent submissions cannot reset an enrolled account.
      const [owner] = await tx.select().from(users).where(eq(users.id, "dev-local-user")).for("update");
      if (!owner) return null;
      const [existing] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, owner.id), eq(accounts.providerId, "credential")));
      if (existing) return null;
      await tx.insert(accounts).values({ id: crypto.randomUUID(), userId: owner.id, accountId: owner.id, providerId: "credential", issuer: "local:credential", password: hashed });
      await tx.insert(userRoles).values({ userId: owner.id, role: "admin" }).onConflictDoNothing();
      return owner.email;
    });
    if (!email) return context.json({ error: "Configuração já concluída ou indisponível. Entre com sua senha." }, 409);
    // BetterAuth owns cookie settings, hashing verification, audit and session lifecycle.
    const response = await auth.handler(new Request(new URL("/api/auth/sign-in/email", config.auth.baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password }),
    }));
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return routes;
}
