import { expect, test } from "bun:test";
import { z } from "zod";
import { acpToolsForProvider } from "../src/acp/tool-names";
import { createToolBridge } from "../src/acp/tool-bridge";
import { AcpPermissionGate } from "../src/acp/permissions";
import type { GrantedTool } from "../src/plugins/tools";

const tool = (name: string): GrantedTool => ({
  name, ref: "routines/list_routines", description: "Read the owner's routines.",
  parameters: z.object({}).strict(), execute: async () => "owner-bound-result",
});

test("Grok receives stable simple names while other ACP providers retain their canonical tools", () => {
  const source = [tool("mcp__routines__list_routines"), tool("message_bot")];
  for (const provider of ["codex", "claude", "pi"] as const) {
    expect(acpToolsForProvider(provider, source)).toEqual({ tools: source, guidance: "" });
    expect(acpToolsForProvider(provider, source).tools).toBe(source);
  }
  const mapped = acpToolsForProvider("grok", source);
  expect(mapped.tools[0]!.name).toMatch(/^mcp_routines_list_routines_[a-f0-9]{16}$/);
  expect(mapped.tools[0]!.name).not.toContain("__");
  expect(mapped.tools[0]!.execute).toBe(source[0]!.execute);
  expect(mapped.tools[0]!.ref).toBe(source[0]!.ref);
  expect(mapped.tools[1]).toBe(source[1]);
  expect(mapped.guidance).toContain(`routines/list_routines: ownbot__${mapped.tools[0]!.name}`);
  expect(acpToolsForProvider("grok", source).tools).toEqual(mapped.tools);
});

test("similar connector slugs, long names, and tool reordering cannot alias one another", () => {
  const sources = ["mcp__a-b__read", "mcp__a_b__read", "mcp_a_b_read", `mcp__${"x".repeat(80)}__read`].map(tool);
  const mapped = acpToolsForProvider("grok", sources).tools;
  expect(new Set(mapped.map(t => t.name)).size).toBe(4);
  for (const t of mapped) expect(t.name.length).toBeLessThanOrEqual(64);
  expect(acpToolsForProvider("grok", [...sources].reverse()).tools.map(t => t.name)).toEqual(mapped.map(t => t.name).reverse());
  expect(() => acpToolsForProvider("grok", [sources[0]!, sources[0]!])).toThrow("Duplicate ACP tool name");
});

test("Grok alias discovery and permission still call only the original owner-bound capability", async () => {
  let calls = 0;
  const source = { ...tool("mcp__routines__list_routines"), execute: async () => { calls++; return "owner-A routines"; } };
  const mapped = acpToolsForProvider("grok", [source]).tools;
  const name = mapped[0]!.name;
  const bridge = await createToolBridge(mapped);
  try {
    const request = async (method: string, params?: unknown) => {
      const response = await fetch(bridge.descriptor.url, {
        method: "POST", headers: { "Content-Type": "application/json", ...Object.fromEntries(bridge.descriptor.headers.map(h => [h.name, h.value])) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return await response.json() as any;
    };
    expect((await request("tools/list")).result.tools.map((t: any) => t.name)).toEqual([name]);
    const gate = new AcpPermissionGate("grok", new Set(mapped.map(t => t.name)));
    const call = { toolCallId: "routine-read", rawInput: { variant: "MCPTool", tool_name: `ownbot__${name}`, tool_input: {} } };
    gate.observe({ ...call, sessionUpdate: "tool_call_update", status: "pending" });
    expect(gate.decide({ sessionId: "owner-A-session", toolCall: call, options: [{ optionId: "once", kind: "allow_once" }] }, "owner-B-session")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(gate.decide({ sessionId: "owner-A-session", toolCall: call, options: [{ optionId: "once", kind: "allow_once" }] }, "owner-A-session")).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect((await request("tools/call", { name, arguments: {} })).result.content[0].text).toBe("owner-A routines");
    expect((await request("tools/call", { name: "list_routines", arguments: {} })).error.message).toBe("Tool not granted");
    expect((await request("tools/call", { name: source.name, arguments: {} })).error.message).toBe("Tool not granted");
    expect((await request("tools/call", { name, arguments: { ownerId: "owner-B" } })).error.message).toBe("Invalid tool arguments");
    expect(calls).toBe(1);
  } finally { await bridge.close(); }
});
