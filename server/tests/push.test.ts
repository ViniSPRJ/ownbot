import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { type AuthService, createRequireUser } from "../src/auth/guards";
import {
  genericPushPayload,
  parsePushSubscription,
  pushEndpointAllowed,
  pushEndpointHash,
  readPushConfig,
} from "../src/notifications/push-config";
import { createPushRoutes } from "../src/notifications/push-routes";
import { startPushWorker } from "../src/notifications/push-worker";

export function fixtureSubscription(suffix = "test") {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://web.push.apple.com/${suffix}`,
    expirationTime: null,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
}
const vapid = {
  subject: "mailto:operator@example.com",
  ...webpush.generateVAPIDKeys(),
};

test("push endpoint allowlist rejects SSRF, userinfo, redirects-by-URL and lookalikes", () => {
  for (const url of [
    "http://web.push.apple.com/token",
    "https://127.0.0.1/token",
    "https://100.122.56.122/token",
    "https://evil.example/token",
    "https://web.push.apple.com.evil.test/token",
    "https://user:pass@web.push.apple.com/token",
    "https://web.push.apple.com:444/token",
    "https://web.push.apple.com/token#secret",
  ])
    expect(pushEndpointAllowed(url)).toBe(false);
  for (const url of [
    "https://web.push.apple.com/token",
    "https://fcm.googleapis.com/fcm/send/token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://wns2-test.notify.windows.com/w/?token=opaque",
  ])
    expect(pushEndpointAllowed(url)).toBe(true);
});
test("subscription keys are bounded valid curve points and expired subscriptions fail", () => {
  const valid = fixtureSubscription();
  expect(parsePushSubscription(valid)).not.toBeNull();
  for (const bad of [
    { ...valid, expirationTime: 1 },
    { ...valid, keys: { ...valid.keys, auth: "a" } },
    {
      ...valid,
      keys: {
        ...valid.keys,
        p256dh: Buffer.alloc(65, 4).toString("base64url"),
      },
    },
    { ...valid, owner: "other" },
    { ...valid, endpoint: `https://web.push.apple.com/${"x".repeat(3000)}` },
  ])
    expect(parsePushSubscription(bad)).toBeNull();
});
test("VAPID private file is required, validated and never returned by configuration status shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownbot-push-"));
  const path = join(dir, "vapid.json");
  try {
    writeFileSync(path, JSON.stringify(vapid), { mode: 0o600 });
    expect(readPushConfig({ OPENBOT_WEB_PUSH_CONFIG: path })).toEqual(vapid);
    chmodSync(path, 0o644);
    expect(readPushConfig({ OPENBOT_WEB_PUSH_CONFIG: path })).toBeNull();
    chmodSync(path, 0o600);
    writeFileSync(
      path,
      JSON.stringify({
        ...vapid,
        privateKey: webpush.generateVAPIDKeys().privateKey,
      }),
    );
    expect(readPushConfig({ OPENBOT_WEB_PUSH_CONFIG: path })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(readPushConfig({})).toBeNull();
});
test("payload is fixed generic text with bounded correlation ID only", () => {
  expect(JSON.parse(genericPushPayload("routine:test"))).toEqual({
    title: "ownbot",
    body: "Há uma nova atualização no seu projeto.",
    notificationId: "routine:test",
  });
  expect(
    JSON.parse(genericPushPayload("x".repeat(180))).notificationId,
  ).toHaveLength(64);
  expect(() => genericPushPayload("private document title\n")).toThrow();
  expect(pushEndpointHash("endpoint")).toMatch(/^[a-f0-9]{64}$/);
});

function routes(actor: string | null, enabled = true) {
  const calls: unknown[][] = [];
  const auth = {
    api: {
      getSession: async () =>
        actor ? { user: { id: actor, email: "test@example.invalid" } } : null,
    },
  } as unknown as AuthService;
  const app = createPushRoutes(
    {
      list: async (owner) => {
        calls.push(["list", owner]);
        return [{ id: "device", endpointHash: "hash" }];
      },
      subscribe: async (owner, s, key) => {
        calls.push(["subscribe", owner, s, key]);
        return "device";
      },
      unsubscribe: async (owner, endpoint) => {
        calls.push(["unsubscribe", owner, endpoint]);
      },
    },
    createRequireUser(auth, { rolesForUser: async () => ["user"] }),
    () => (enabled ? vapid : null),
    { allowedOrigins: ["https://ownbot.example"] },
  );
  return { app, calls };
}
const json = (
  method: string,
  body: unknown,
  origin = "https://ownbot.example",
) => ({
  method,
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(body),
});
test("all push routes authenticate and derive owner from login only", async () => {
  const anonymous = routes(null);
  expect((await anonymous.app.request("/")).status).toBe(401);
  expect(
    (
      await anonymous.app.request(
        "/subscriptions",
        json("POST", fixtureSubscription()),
      )
    ).status,
  ).toBe(401);
  expect(anonymous.calls).toEqual([]);
  const { app, calls } = routes("alice");
  const status = await app.request("/?owner=bob");
  expect(await status.json()).toEqual({
    push: {
      enabled: true,
      publicKey: vapid.publicKey,
      subscriptions: [{ id: "device", endpointHash: "hash" }],
    },
  });
  expect(status.headers.get("cache-control")).toBe("private, no-store");
  expect(
    (await app.request("/subscriptions", json("POST", fixtureSubscription())))
      .status,
  ).toBe(200);
  expect(calls[1]?.[1]).toBe("alice");
  expect(
    (
      await app.request(
        "/subscriptions",
        json("DELETE", { endpoint: fixtureSubscription().endpoint }),
      )
    ).status,
  ).toBe(200);
  expect(calls[2]?.[1]).toBe("alice");
});
test("cross-site, invalid, oversized and disabled push registration refuse before store", async () => {
  const { app, calls } = routes("alice");
  expect(
    (
      await app.request(
        "/subscriptions",
        json("POST", fixtureSubscription(), "https://evil.example"),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        "/subscriptions",
        json("POST", { ...fixtureSubscription(), owner: "bob" }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        "/subscriptions",
        json("POST", { data: "x".repeat(5000) }),
      )
    ).status,
  ).toBe(413);
  expect(calls).toEqual([]);
  const disabled = routes("alice", false);
  expect(
    (
      await disabled.app.request(
        "/subscriptions",
        json("POST", fixtureSubscription()),
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await disabled.app.request(
        "/subscriptions",
        json("DELETE", { endpoint: fixtureSubscription().endpoint }),
      )
    ).status,
  ).toBe(200);
});
test("worker neither claims nor sends when operator config is absent", async () => {
  let claims = 0;
  const worker = startPushWorker(
    {
      claim: async () => {
        claims++;
        return null;
      },
      deliver: async () => {
        throw Error("must not send");
      },
      prune: async () => {},
    },
    { config: () => null, intervalMs: 5 },
  );
  await new Promise((r) => setTimeout(r, 15));
  await worker.stop();
  expect(claims).toBe(0);
});

test("application mounts authenticated push status without trailing slash and respects configured proxy origin", async () => {
  const { createApp } = await import("../src/app");
  const { loadConfig } = await import("../src/config");
  const { testEnvironment } = await import("./support/environment");
  const dir = mkdtempSync(join(tmpdir(), "ownbot-push-app-"));
  const path = join(dir, "vapid.json");
  const previous = process.env.OPENBOT_WEB_PUSH_CONFIG;
  try {
    writeFileSync(path, JSON.stringify(vapid), { mode: 0o600 });
    process.env.OPENBOT_WEB_PUSH_CONFIG = path;
    const config = loadConfig({
      ...testEnvironment(),
      TRUSTED_ORIGINS: "https://ownbot.example",
    });
    const push = {
      list: async () => [],
      subscribe: async () => "device",
      unsubscribe: async () => {},
      claim: async () => null,
      deliver: async () => {},
      prune: async () => {},
    };
    const args: Parameters<typeof createApp> = [config];
    args[1] = {
      handler: async () => new Response(),
      api: {
        getSession: async () => ({
          user: { id: "alice", email: "alice@example.invalid" },
        }),
      },
    } as unknown as AuthService;
    args[2] = { rolesForUser: async () => ["user"] };
    args[30] = push;
    const app = createApp(...args);
    const response = await app.request(
      "http://backend.internal/api/notifications/push",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      push: { enabled: true, publicKey: vapid.publicKey, subscriptions: [] },
    });
    expect(
      (
        await app.request(
          "http://backend.internal/api/notifications/push/subscriptions",
          json("POST", fixtureSubscription()),
        )
      ).status,
    ).toBe(200);
    args[1] = {
      handler: async () => new Response(),
      api: { getSession: async () => null },
    } as unknown as AuthService;
    expect(
      (await createApp(...args).request("/api/notifications/push")).status,
    ).toBe(401);
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_WEB_PUSH_CONFIG;
    else process.env.OPENBOT_WEB_PUSH_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
