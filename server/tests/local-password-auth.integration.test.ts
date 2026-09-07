import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuth } from "../src/auth";
import { createLocalEnrollmentRoutes } from "../src/auth/local-enrollment";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, sessions, users } from "../src/db/schema";

const url = process.env.DATABASE_URL;
const isolated = url && /(?:test|codex)/i.test(new URL(url).pathname);
test.skipIf(!isolated)("local enrollment creates session, rejects replay, wrong password and public signup", async () => {
  const db = createDatabase(url!);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const config = loadConfig({
    ...process.env, NODE_ENV: "test", DATABASE_URL: url, KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    OPENBOT_LOCAL_PASSWORD_AUTH: "true", BETTER_AUTH_SECRET: "local-auth-isolated-test-secret-with-32-chars",
    BETTER_AUTH_URL: "https://openbot.example.test", INITIAL_ADMIN_EMAILS: "dev@openbot.local",
    OPENBOT_LOCAL_ENROLLMENT_TOKEN_HASH: createHash("sha256").update(token).digest("hex"),
    INTELLIGENCE_API_URL: "http://localhost:7100", INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103", INTELLIGENCE_API_KEY: "test", COPILOTKIT_LICENSE_TOKEN: "test",
  });
  const existing = await db.select().from(accounts).where(and(eq(accounts.userId, "dev-local-user"), eq(accounts.providerId, "credential")));
  if (existing.length) throw Error("Isolated owner already enrolled; refusing to overwrite credential");
  await db.insert(users).values({ id: "dev-local-user", email: "dev@openbot.local", name: "Local operator" }).onConflictDoNothing();
  const auth = createAuth(config, db);
  const routes = createLocalEnrollmentRoutes(db, auth, config);
  const headers = { "Content-Type": "application/json", Origin: config.auth!.baseUrl };
  const password = "isolated-test-password-" + crypto.randomUUID();
  try {
    const response = await routes.request("/enroll", { method: "POST", headers, body: JSON.stringify({ token, password }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    const body = await response.json();
    expect(body.user.id).toBe("dev-local-user");
    const replay = await routes.request("/enroll", { method: "POST", headers, body: JSON.stringify({ token, password: "replacement-password" }) });
    expect(replay.status).toBe(409);
    const wrong = await auth.handler(new Request(config.auth!.baseUrl + "/api/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ email: "dev@openbot.local", password: "incorrect-password" }) }));
    expect(wrong.status).toBe(401);
    const signup = await auth.handler(new Request(config.auth!.baseUrl + "/api/auth/sign-up/email", { method: "POST", headers, body: JSON.stringify({ name: "Intruder", email: "new@example.test", password }) }));
    expect(signup.ok).toBe(false);
  } finally {
    await db.delete(sessions).where(eq(sessions.userId, "dev-local-user"));
    await db.delete(accounts).where(and(eq(accounts.userId, "dev-local-user"), eq(accounts.providerId, "credential")));
    await db.$client.close();
  }
});
