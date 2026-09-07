import { expect, test } from "bun:test";
import { AcpPermissionGate, type AcpProvider } from "../src/acp/permissions";

const option = { optionId: "once", kind: "allow_once" };
function fixture(provider: AcpProvider, tool = "echo") {
  const id = "call-1";
  const call = provider === "codex"
    ? { toolCallId: id, _meta: { is_mcp_tool_call: true }, rawInput: { server: "ownbot", tool } }
    : provider === "claude"
      ? { toolCallId: id, name: `mcp__ownbot__${tool}`, _meta: { claudeCode: { toolName: `mcp__ownbot__${tool}` } }, rawInput: { text: "hi" } }
      : { toolCallId: id, rawInput: { variant: "MCPTool", tool_name: `ownbot__${tool}`, tool_input: { text: "hi" } } };
  return { update: { ...call, sessionUpdate: provider === "grok" ? "tool_call_update" : "tool_call", status: "pending" },
    request: { sessionId: "s1", toolCall: call, options: [option], ...(provider === "codex" ? { _meta: { is_mcp_tool_approval: true } } : {}) } };
}

for (const provider of ["codex", "claude", "grok"] as const) {
  test(`${provider}: permits a correlated ownbot grant once and rejects notification replay`, () => {
    const gate = new AcpPermissionGate(provider, new Set(["echo"]));
    const {update, request} = fixture(provider);
    gate.observe(update);
    expect(gate.decide(request, "s1")).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    gate.observe(update);
    expect(gate.decide(request, "s1")).toEqual({ outcome: { outcome: "cancelled" } });
  });
  test(`${provider}: rejects missing grants, unknown calls, wrong session and persistent approval`, () => {
    const gate = new AcpPermissionGate(provider, new Set(["echo"]));
    const {update, request} = fixture(provider);
    expect(gate.decide(request,"s1")).toEqual({outcome:{outcome:"cancelled"}});
    gate.observe(fixture(provider,"not-granted").update);
    expect(gate.decide(request,"s1")).toEqual({outcome:{outcome:"cancelled"}});
    gate.observe(update);
    expect(gate.decide(request,"other")).toEqual({outcome:{outcome:"cancelled"}});
    expect(gate.decide({...request,options:[{optionId:"forever",kind:"allow_always"}]},"s1")).toEqual({outcome:{outcome:"cancelled"}});
    gate.observe({...update,status:"completed"});
    expect(gate.decide(request,"s1")).toEqual({outcome:{outcome:"cancelled"}});
  });
  test(`${provider}: display titles cannot grant native file or shell access`, () => {
    const gate = new AcpPermissionGate(provider, new Set(["echo"]));
    gate.observe({sessionUpdate:"tool_call",toolCallId:"native",title:"ownbot__echo",rawInput:{variant:"Bash",command:"echo hi"}});
    expect(gate.decide({sessionId:"s1",toolCall:{toolCallId:"native",title:"ownbot__echo"},options:[option]},"s1")).toEqual({outcome:{outcome:"cancelled"}});
  });
}
test("Claude and Grok reject a changed MCP target in the permission request", () => {
  for (const provider of ["claude","grok"] as const) {
    const gate = new AcpPermissionGate(provider,new Set(["echo","another"]));
    gate.observe(fixture(provider).update);
    expect(gate.decide(fixture(provider,"another").request,"s1")).toEqual({outcome:{outcome:"cancelled"}});
  }
});
