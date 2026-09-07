import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validEnrollmentToken, createLocalEnrollmentRoutes } from "../src/auth/local-enrollment";
import { loadConfig } from "../src/config";
const token = "a".repeat(64);
const hash = createHash("sha256").update(token).digest("hex");
const environment = {
  DATABASE_URL: "postgres://test:test@localhost/test", KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  INTELLIGENCE_API_URL: "http://localhost:7100", INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103", INTELLIGENCE_API_KEY: "test-key", COPILOTKIT_LICENSE_TOKEN: "test-token",
  OPENBOT_RUNTIME_MODE: "local", OPENBOT_SINGLE_USER: "true", OPENBOT_LOCAL_PASSWORD_AUTH: "true",
  BETTER_AUTH_SECRET: "a".repeat(40), BETTER_AUTH_URL: "https://openbot.example.test",
  INITIAL_ADMIN_EMAILS: "dev@openbot.local", OPENBOT_LOCAL_ENROLLMENT_TOKEN_HASH: hash,
};
describe("local password enrollment", () => {
  test("token requires exact digest and well-formed high entropy capability", () => {
    expect(validEnrollmentToken(token, hash)).toBe(true);
    expect(validEnrollmentToken("b".repeat(64), hash)).toBe(false);
    expect(validEnrollmentToken(token, "bad")).toBe(false);
    expect(validEnrollmentToken({}, hash)).toBe(false);
    expect(validEnrollmentToken("short", hash)).toBe(false);
    expect(validEnrollmentToken(token)).toBe(false);
  });
  test("local credentials override development bypass without cloud provider", () => {
    const config = loadConfig(environment);
    expect(config.singleUser).toBe(false);
    expect(config.auth?.localPassword).toBe(true);
    expect(config.auth?.localEnrollmentTokenHash).toBe(hash);
  });
  test("requires signing secret and administrator configuration", () => {
    expect(() => loadConfig({ ...environment, BETTER_AUTH_SECRET: "" })).toThrow();
    expect(() => loadConfig({ ...environment, INITIAL_ADMIN_EMAILS: "" })).toThrow();
  });
  test("rejects absent/foreign Origin and bad token before DB access", async () => {
    const config = loadConfig(environment);
    const routes = createLocalEnrollmentRoutes({ transaction: () => { throw Error("DB must not be called"); } } as never, { handler: async () => { throw Error("auth must not be called"); } }, config);
    for (const origin of [undefined, "https://evil.test"]) {
      const response = await routes.request("/enroll", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ token, password: "long-enough-password" }) });
      expect(response.status).toBe(403);
    }
    const response = await routes.request("/enroll", { method: "POST", headers: { "Content-Type": "application/json", Origin: environment.BETTER_AUTH_URL }, body: JSON.stringify({ token: "b".repeat(64), password: "long-enough-password" }) });
    expect(response.status).toBe(403);
  });
});
