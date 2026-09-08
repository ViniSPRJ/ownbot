import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiAcpAdapter } from "../src/adapter";
import { configSchema, tailnetUrl } from "../src/config";
import { createToolBridge } from "../../../server/src/acp/tool-bridge";
import { AcpPermissionGate } from "../../../server/src/acp/permissions";
import { z } from "zod";
const adapters: PiAcpAdapter[] = [],
  roots: string[] = [],
  bridges: Awaited<ReturnType<typeof createToolBridge>>[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  for (const b of bridges.splice(0)) await b.close();
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
const models = [
  {
    id: "m4",
    name: "M4",
    model: "nemotron",
    baseUrl: "http://100.92.206.45:8081/v1",
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "m5",
    name: "M5",
    model: "qwen",
    baseUrl: "http://100.83.149.120:8080/v1",
    contextWindow: 131072,
    maxTokens: 8192,
  },
];
async function setup({
  cwd,
  deny = false,
  fingerprint = "test",
}: {
  cwd?: string;
  deny?: boolean;
  fingerprint?: string;
} = {}) {
  cwd ??= await mkdtemp(join(tmpdir(), "pi-acp-test-"));
  if (!roots.includes(cwd)) roots.push(cwd);
  const gate = new AcpPermissionGate("pi", new Set(["echo"]));
  let calls = 0;
  let current: string | undefined;
  const bridge = await createToolBridge([
    {
      name: "echo",
      ref: "ownbot/echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => {
        calls++;
        return (args as { text: string }).text;
      },
    },
  ]);
  bridges.push(bridge);
  const a = new PiAcpAdapter({
    config: {
      piCommand: resolve(import.meta.dir, "fixture-pi.ts"),
      defaultModel: "m4",
      models,
    },
    fingerprint,
    cwd,
    notify: (_, params) => {
      current = params.sessionId;
      gate.observe(params.update);
    },
    permission: async (params) =>
      deny
        ? { outcome: { outcome: "cancelled" } }
        : gate.decide(params, current),
  });
  adapters.push(a);
  const start = () =>
    a.request("session/new", { cwd, mcpServers: [bridge.descriptor] });
  return { a, cwd, bridge, start, calls: () => calls };
}
test("operator config admits only exact Tailnet model endpoints and known models", () => {
  for (const url of [
    "https://api.openai.com/v1",
    "http://127.0.0.1:8080/v1",
    "http://100.1.2.3/v1",
    "http://100.92.206.45/v1?redirect=evil",
    "http://user:pass@100.92.206.45/v1",
    "http://100.92.206.45/admin",
  ])
    expect(tailnetUrl(url)).toBe(false);
  expect(tailnetUrl(models[0]!.baseUrl)).toBe(true);
  expect(tailnetUrl("https://mac.tail3c3777.ts.net:8080/v1")).toBe(true);
  expect(() =>
    configSchema.parse({
      piCommand: "/bin/pi",
      defaultModel: "missing",
      models,
    }),
  ).toThrow();
  expect(() =>
    configSchema.parse({
      piCommand: "/bin/pi",
      defaultModel: "m4",
      models,
      apiKey: "cloud",
    }),
  ).toThrow();
});
test("native tools disabled, catalogue and model selection confirmed by Pi RPC", async () => {
  const s = await setup();
  const session = await s.start();
  expect(session.configOptions[0].currentValue).toBe("m4");
  const changed = await s.a.request("session/set_config_option", {
    sessionId: session.sessionId,
    configId: "model",
    value: "m5",
  });
  expect(changed.configOptions[0].currentValue).toBe("m5");
  expect(
    await s.a.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    }),
  ).toEqual({ stopReason: "end_turn" });
  await expect(
    s.a.request("session/set_model", {
      sessionId: session.sessionId,
      modelId: "hosted",
    }),
  ).rejects.toThrow();
});
test("tool execution goes through current Ownbot bridge and Pi ACP one-shot permission gate", async () => {
  const s = await setup();
  const { sessionId } = await s.start();
  await s.a.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "CALL" }],
  });
  expect(s.calls()).toBe(1);
});
test("denied permission never invokes Ownbot tool and fails the turn", async () => {
  const s = await setup({ deny: true });
  const { sessionId } = await s.start();
  await expect(
    s.a.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "CALL" }],
    }),
  ).rejects.toThrow();
  expect(s.calls()).toBe(0);
});
test("session survives process replacement, rejects foreign owner and changed operator config", async () => {
  const s = await setup();
  const { sessionId } = await s.start();
  await s.a.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  await s.a.close();
  const next = await setup({ cwd: s.cwd });
  expect(
    (
      await next.a.request("session/load", {
        sessionId,
        cwd: s.cwd,
        mcpServers: [next.bridge.descriptor],
      })
    ).sessionId,
  ).toBe(sessionId);
  const other = await setup();
  await expect(
    other.a.request("session/load", {
      sessionId,
      cwd: other.cwd,
      mcpServers: [],
    }),
  ).rejects.toThrow();
  const changed = await setup({ cwd: s.cwd, fingerprint: "new-config" });
  await expect(
    changed.a.request("session/load", {
      sessionId,
      cwd: s.cwd,
      mcpServers: [],
    }),
  ).rejects.toThrow();
});
test("failed or cancelled prompt restores prior transcript instead of persisting a partial turn", async () => {
  const s = await setup();
  const { sessionId } = await s.start();
  const file = join(s.cwd, ".pi-acp", sessionId, "session.jsonl");
  const before = await readFile(file, "utf8");
  await expect(
    s.a.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "FAIL" }],
    }),
  ).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  const n = await setup();
  const ns = await n.start();
  const work = n.a.request("session/prompt", {
    sessionId: ns.sessionId,
    prompt: [{ type: "text", text: "WAIT" }],
  });
  await Bun.sleep(20);
  await n.a.request("session/cancel", { sessionId: ns.sessionId });
  expect(await work).toEqual({ stopReason: "cancelled" });
  expect(
    await readFile(
      join(n.cwd, ".pi-acp", ns.sessionId, "session.jsonl"),
      "utf8",
    ),
  ).toBe("INITIAL\n");
});
test("foreign cwd, native ACP filesystem operations and non-ownbot MCP servers are refused", async () => {
  const s = await setup();
  await expect(
    s.a.request("session/new", { cwd: tmpdir(), mcpServers: [] }),
  ).rejects.toThrow();
  await expect(
    s.a.request("session/new", {
      cwd: s.cwd,
      mcpServers: [{ ...s.bridge.descriptor, url: "https://example.com/mcp" }],
    }),
  ).rejects.toThrow();
  await expect(
    s.a.request("fs/write_text_file", { path: "/tmp/escape", content: "x" }),
  ).rejects.toThrow();
});
