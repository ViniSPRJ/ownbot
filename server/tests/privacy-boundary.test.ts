import { afterEach, describe, expect, test } from "bun:test";
import { buildAgents } from "../src/copilot";
import { isPrivateAgent, privateModelRoute, privateModelFetch } from "../src/privacy/policy";
const saved = { ...process.env };
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
const env = { OPENBOT_NOTIFICATION_DELIVERY: "internal", OPENBOT_SELF_HOSTED: "true", OPENBOT_PRIVATE_MODEL_VERIFIED: "true", OPENBOT_PRIVATE_MODEL: "qwen", OPENBOT_PRIVATE_MODEL_BASE_URL: "http://100.83.149.120:8080/v1" };
describe("private trust domain", () => {
  test("exact ID membership, no substring or inferred classification", () => {
    expect(isPrivateAgent("coord", { OPENBOT_PRIVATE_AGENT_IDS: "coord, credito" })).toBe(true);
    expect(isPrivateAgent("co", { OPENBOT_PRIVATE_AGENT_IDS: "coord" })).toBe(false);
    expect(isPrivateAgent("news", { OPENBOT_PRIVATE_AGENT_IDS: "coord" })).toBe(false);
  });
  test("requires explicit local validation and local threads", () => {
    expect(() => privateModelRoute({ ...env, OPENBOT_PRIVATE_MODEL_VERIFIED: "false" })).toThrow();
    expect(() => privateModelRoute({ ...env, OPENBOT_SELF_HOSTED: "false" })).toThrow();
    expect(privateModelRoute(env).model).toBe("qwen");
  });
  test("rejects cloud, LAN, credentials, query and ambiguous DNS endpoints", () => {
    for (const endpoint of ["https://api.openai.com/v1", "http://192.168.1.2:8080/v1", "http://localhost.evil/v1", "http://user:pass@localhost/v1", "http://localhost/v1?x=1", "http://100.128.0.1/v1"])
      expect(() => privateModelRoute({ ...env, OPENBOT_PRIVATE_MODEL_BASE_URL: endpoint })).toThrow();
  });
  test("network boundary refuses another host/path and disables redirects", async () => {
    let calls = 0;
    const guarded = privateModelFetch(env.OPENBOT_PRIVATE_MODEL_BASE_URL, (async (_input, init) => { calls++; expect(init?.redirect).toBe("error"); return new Response("ok"); }) as typeof fetch);
    await expect(guarded("https://example.com/v1/chat/completions")).rejects.toThrow();
    await expect(guarded("http://100.83.149.120:8080/other")).rejects.toThrow();
    expect(calls).toBe(0);
    await guarded("http://100.83.149.120:8080/v1/chat/completions");
    expect(calls).toBe(1);
  });
  test("refuses redirect even if custom transport does not implement redirect:error", async () => {
    const guarded = privateModelFetch(env.OPENBOT_PRIVATE_MODEL_BASE_URL, (async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })) as typeof fetch);
    await expect(guarded("http://100.83.149.120:8080/v1/chat/completions")).rejects.toThrow();
  });
  test("private unavailable route bypasses tool loading and model selection", async () => {
    process.env.OPENBOT_PRIVATE_AGENT_IDS = "coord";
    delete process.env.OPENBOT_PRIVATE_MODEL_VERIFIED;
    let loads = 0;
    const agents = await buildAgents([{ id: "coord", name: "Coord", type: "built_in", systemPrompt: "private" }], { provider: "openai", defaultModel: "external" }, "external-secret", undefined, async () => { loads++; return []; });
    expect(loads).toBe(0);
    expect(() => agents.coord!.run({ threadId: "t", runId: "r", messages: [], tools: [], context: [], state: {} })).toThrow("validação");
  });
});

import { LocalAgentRunner } from "../src/local-threads";
import { parseChannelInput } from "../src/channels/routes";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("private thread classification persists across runner restart and refuses public admission", () => {
  process.env.OPENBOT_PRIVATE_AGENT_IDS = "onyx,credito";
  const dir = mkdtempSync(join(tmpdir(), "openbot-privacy-"));
  try {
    const first = new LocalAgentRunner(join(dir, "threads.db"));
    first.admitTrustDomain("secret", "onyx");
    const second = new LocalAgentRunner(join(dir, "threads.db"));
    expect(() => second.admitTrustDomain("secret", "coord")).toThrow("privado");
    expect(() => second.admitTrustDomain("secret", "credito")).not.toThrow();
    second.admitTrustDomain("public", "news");
    expect(() => first.admitTrustDomain("public", "onyx")).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("mixed public/private channels are refused but same-domain channels remain available", () => {
  process.env.OPENBOT_PRIVATE_AGENT_IDS = "onyx,credito";
  expect(parseChannelInput({ agentIds: ["onyx", "coord"] }).ok).toBe(false);
  expect(parseChannelInput({ agentIds: ["onyx", "credito"] }).ok).toBe(true);
  expect(parseChannelInput({ agentIds: ["news", "coord"] }).ok).toBe(true);
});

test("private inference uses dedicated model and dummy credential, never advertises client or MCP tools", async () => {
  Object.assign(process.env, env, { OPENBOT_PRIVATE_AGENT_IDS: "onyx" });
  const original = globalThis.fetch;
  const requests: { url: string; auth: string | null; body: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"role":"assistant","content":"Local"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const agents = await buildAgents([{ id: "onyx", name: "Onyx", type: "built_in", systemPrompt: "private memory" }], { provider: "openai", defaultModel: "cloud-model" }, "cloud-secret", undefined, async () => { throw new Error("must not load MCP"); });
    await new Promise<void>((resolve, reject) => agents.onyx!.clone().run({ threadId: "private", runId: "r", messages: [{ id: "m", role: "user", content: "private question" }], tools: [{ name: "exfiltrate", description: "send out", parameters: {} }], context: [], state: {} }).subscribe({ complete: resolve, error: reject }));
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("http://100.83.149.120:8080/v1/chat/completions");
    expect(requests[0]!.auth).toBe("Bearer local-private");
    expect(requests[0]!.body.model).toBe("qwen");
    expect((requests[0]!.body.tools ?? []).every((t: any) => ["AGUISendStateSnapshot", "AGUISendStateDelta"].includes(t.function.name))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("cloud-secret");
  } finally { globalThis.fetch = original; }
});
