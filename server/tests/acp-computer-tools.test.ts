import { expect, test } from "bun:test";
import { acpComputerTools } from "../src/acp/computer-tools";
import { createToolBridge } from "../src/acp/tool-bridge";
import { createHeadlessComputer } from "../src/routines/headless-computer";
import { ActionRefusedError, type ComputerGateway } from "../src/computer/gateway";

test("ACP computer MCP preserves authenticated actor, bot scope, argument validation and gateway refusal", async () => {
  const calls: unknown[][] = [];
  const gateway = {
    navigate: async (...args: unknown[]) => { calls.push(args); return { title: "Public source" }; },
    runCommand: async (...args: unknown[]) => { calls.push(args); throw new ActionRefusedError("Denied by existing policy", "no-shell"); },
  } as unknown as ComputerGateway;
  const computer = createHeadlessComputer({ gateway, actorFor: id => ({ id, userId: id }) });
  const tools = acpComputerTools(computer, "research", "owner");
  expect(tools.some(t => t.name === "computer_request_secret")).toBe(false);
  const bridge = await createToolBridge(tools);
  const call = async (name: string, args: unknown) => {
    const response = await fetch(bridge.descriptor.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bridge.descriptor.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return response.json();
  };
  try {
    expect((await call("computer_navigate", { url: 42 })).error.code).toBe(-32602);
    expect(calls).toEqual([]);
    const navigated = await call("computer_navigate", { url: "https://example.invalid", ownerUserId: "victim", botId: "coord" });
    expect(JSON.parse(navigated.result.content[0].text)).toEqual({ ok: true, title: "Public source" });
    expect(calls[0]).toEqual(["research", { id: "owner", userId: "owner" }, "https://example.invalid"]);
    const refused = await call("computer_run_command", { command: "uname" });
    expect(JSON.parse(refused.result.content[0].text)).toEqual({ ok: false, reason: "Denied by existing policy", refused: true, rule: "no-shell" });
    expect(calls[1]?.[0]).toBe("research");
    expect(calls[1]?.[1]).toEqual({ id: "owner", userId: "owner" });
  } finally { await bridge.close(); }
});
