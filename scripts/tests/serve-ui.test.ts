import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUiServer } from "../serve-ui";

describe("production UI server (local fixtures only)", () => {
  let temp: string;
  let base: string;
  let ui: Awaited<ReturnType<typeof createUiServer>>;
  let stub: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "openbot-ui-test-"));
    await mkdir(path.join(temp, "dist/assets"), { recursive: true });
    await writeFile(
      path.join(temp, "dist/index.html"),
      "<!doctype html><title>Test UI</title>",
    );
    await writeFile(
      path.join(temp, "dist/assets/main-abcdefgh.js"),
      "console.log('test')",
    );
    await writeFile(path.join(temp, "dist/profile.mobileconfig"), "profile");
    await writeFile(path.join(temp, "outside.txt"), "secret");
    await symlink(
      path.join(temp, "outside.txt"),
      path.join(temp, "dist/outside.txt"),
    );
    stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (
          url.pathname === "/api/ws" &&
          server.upgrade(req, { data: undefined })
        )
          return;
        if (url.pathname === "/api/rejected")
          return new Response("denied", { status: 403 });
        if (url.pathname === "/api/sse")
          return new Response("event: ready\ndata: ok\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          });
        return Response.json(
          {
            path: url.pathname,
            query: url.search,
            body: await req.text(),
            auth: req.headers.get("authorization"),
            cookie: req.headers.get("cookie"),
            method: req.method,
          },
          { headers: { "Set-Cookie": "session=test; HttpOnly" } },
        );
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });
    ui = await createUiServer({
      dist: path.join(temp, "dist"),
      api: `http://127.0.0.1:${stub.port}`,
      port: 0,
    });
    base = await ui.listen();
  });
  afterAll(async () => {
    await ui?.close();
    stub?.stop(true);
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  test("SPA direct links including saved run results work", async () => {
    for (const route of [
      "/",
      "/channel/channel_123",
      "/routine-runs/run_123",
      "/routines",
    ]) {
      const response = await fetch(base + route);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("Test UI");
    }
  });
  test("static asset caching, HEAD, mobileconfig and missing assets", async () => {
    const asset = await fetch(base + "/assets/main-abcdefgh.js", {
      method: "HEAD",
    });
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe("");
    expect((await fetch(base + "/assets/missing.js")).status).toBe(404);
    expect(
      (await fetch(base + "/profile.mobileconfig")).headers.get("content-type"),
    ).toBe("application/x-apple-aspen-config");
    expect(
      (await fetch(base + "/channel/one", { method: "POST" })).status,
    ).toBe(405);
  });
  test("cannot read symlinks outside build, dotfiles or encoded traversal", async () => {
    expect((await fetch(base + "/outside.txt")).status).toBe(404);
    for (const route of [
      "/.env",
      "/%2e%2e%2foutside.txt",
      "/%5coutside.txt",
      "/%00",
      "/%ZZ",
    ]) {
      expect((await fetch(base + route)).status).toBe(400);
    }
  });
  test("API retains path, query, body, cookies and auth, and streams SSE", async () => {
    const response = await fetch(base + "/api/echo?q=1", {
      method: "POST",
      body: "payload",
      headers: { authorization: "Bearer fake", cookie: "session=fake" },
    });
    expect(await response.json()).toEqual({
      path: "/api/echo",
      query: "?q=1",
      body: "payload",
      auth: "Bearer fake",
      cookie: "session=fake",
      method: "POST",
    });
    expect(response.headers.get("set-cookie")).toContain("session=test");
    expect((await fetch(base + "/api/rejected")).status).toBe(403);
    const sse = await fetch(base + "/api/sse");
    expect(sse.headers.get("content-type")).toBe("text/event-stream");
    expect(await sse.text()).toContain("data: ok");
  });
  test("WebSocket upgrades reach API and relay text/binary", async () => {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/api/ws");
    ws.binaryType = "arraybuffer";
    let phase = 0;
    const exchange = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WS test timed out")),
        3000,
      );
      ws.onopen = () => ws.send("hello");
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WS failed"));
      };
      ws.onmessage = (event) => {
        try {
          if (phase++ === 0) {
            expect(event.data).toBe("hello");
            ws.send(new Uint8Array([1, 2, 3]));
          } else {
            expect(new Uint8Array(event.data)).toEqual(
              new Uint8Array([1, 2, 3]),
            );
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          ws.close();
          reject(error);
        }
      };
    });
    await exchange;
  });
  test("retains Vite host allowlist for HTTP and API requests", async () => {
    expect(
      (await fetch(base + "/", { headers: { Host: "attacker.invalid" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/echo", {
          headers: { Host: "attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/", {
          headers: { Host: "viniciuspinho.tail3c3777.ts.net:3010" },
        })
      ).status,
    ).toBe(200);
  });
  test("health is read-only static liveness", async () => {
    const response = await fetch(base + "/__ui/health");
    expect(await response.json()).toEqual({ status: "ok", mode: "static" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
