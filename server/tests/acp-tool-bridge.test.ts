import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createToolBridge } from "../src/acp/tool-bridge";

describe("ACP loopback tool bridge", () => {
  test("authenticates, advertises only granted tools, validates before execution", async () => {
    const calls: unknown[] = [];
    const bridge = await createToolBridge([{
      name: "lookup", ref: "test/lookup", description: "Lookup a public symbol",
      parameters: z.object({ symbol: z.string().min(1) }).strict(),
      execute: async (args) => { calls.push(args); return "ok"; },
    }]);
    const request = (body: unknown, extra: RequestInit = {}) => fetch(bridge.descriptor.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bridge.descriptor.headers[0]!.value },
      body: JSON.stringify(body), ...extra,
    });
    const rpc = async (method: string, params?: unknown) => (await request({ jsonrpc: "2.0", id: 1, method, params })).json();
    try {
      expect(new URL(bridge.descriptor.url).hostname).toBe("127.0.0.1");
      expect((await request({}, { headers: { "Content-Type": "application/json" } })).status).toBe(401);
      expect((await request({}, { headers: { Authorization: bridge.descriptor.headers[0]!.value, Origin: "https://evil.invalid" } })).status).toBe(403);
      expect((await rpc("initialize")).result.capabilities).toEqual({ tools: {} });
      expect((await request({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const listed = await rpc("tools/list");
      expect(listed.result.tools).toHaveLength(1);
      expect(listed.result.tools[0].inputSchema.properties.symbol.type).toBe("string");
      expect((await rpc("tools/call", { name: "shell", arguments: {} })).error.code).toBe(-32602);
      expect((await rpc("tools/call", { name: "lookup", arguments: { symbol: 1 } })).error.code).toBe(-32602);
      expect((await rpc("tools/call", { name: "lookup", arguments: { symbol: "X", url: "https://evil.invalid" } })).error.code).toBe(-32602);
      expect((await rpc("resources/read", { uri: "file:///private" })).error.code).toBe(-32601);
      expect(calls).toEqual([]);
      expect((await rpc("tools/call", { name: "lookup", arguments: { symbol: "X" } })).result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(calls).toEqual([{ symbol: "X" }]);
    } finally { await bridge.close(); }
    await expect(fetch(bridge.descriptor.url)).rejects.toThrow();
  });

  test("per-run tokens differ and execution exceptions never leak", async () => {
    const a = await createToolBridge([]);
    const b = await createToolBridge([{
      name: "fail", ref: "test/fail", description: "Fails", parameters: z.object({}),
      execute: async () => { throw Error("secret-token"); },
    }]);
    try {
      expect(a.descriptor.headers).not.toEqual(b.descriptor.headers);
      const headers = { "Content-Type": "application/json", Authorization: b.descriptor.headers[0]!.value };
      const response = await fetch(b.descriptor.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fail" } }) });
      const data = await response.json();
      expect(data.result.isError).toBe(true);
      expect(JSON.stringify(data)).not.toContain("secret-token");
      expect((await fetch(b.descriptor.url, { headers })).status).toBe(405);
      expect((await fetch(b.descriptor.url, { method: "POST", headers, body: "{" })).status).toBe(200);
      expect((await fetch(b.descriptor.url, { method: "POST", headers, body: "x".repeat(300_000) })).status).toBe(413);
    } finally { await a.close(); await b.close(); }
  });

  test("duplicate tools fail before a listener opens", async () => {
    const tool = { name: "same", ref: "test/same", description: "", parameters: z.object({}), execute: async () => "" };
    await expect(createToolBridge([tool, tool])).rejects.toThrow("Duplicate");
  });
});
