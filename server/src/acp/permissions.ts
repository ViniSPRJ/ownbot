export type AcpProvider = "codex" | "claude" | "grok";
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;

/** Provider envelopes are emitted by the installed CLI, never inferred from display titles. */
export class AcpPermissionGate {
  private readonly calls = new Map<string, string>();
  private readonly consumed = new Set<string>();
  constructor(private readonly provider: AcpProvider, private readonly granted: ReadonlySet<string>) {}

  private tool(call: ObjectValue, permission = false): string | undefined {
    let name: unknown;
    if (this.provider === "codex") {
      if (call._meta?.is_mcp_tool_call !== true || call.rawInput?.server !== "ownbot") return;
      name = call.rawInput.tool;
    } else if (this.provider === "claude") {
      const qualified = permission ? call.name : call._meta?.claudeCode?.toolName;
      if (typeof qualified !== "string" || !qualified.startsWith("mcp__ownbot__")) return;
      name = qualified.slice("mcp__ownbot__".length);
    } else {
      const input = object(call.rawInput);
      if (input?.variant !== "MCPTool" || typeof input.tool_name !== "string" || !input.tool_name.startsWith("ownbot__")) return;
      name = input.tool_name.slice("ownbot__".length);
    }
    return typeof name === "string" && this.granted.has(name) ? name : undefined;
  }

  observe(value: unknown): void {
    const call = object(value);
    if (!call || !["tool_call", "tool_call_update"].includes(call.sessionUpdate)) return;
    const id = call.toolCallId;
    if (typeof id !== "string" || !id || this.consumed.has(id)) return;
    if (call.status === "completed" || call.status === "failed") {
      this.calls.delete(id); this.consumed.add(id); return;
    }
    const name = this.tool(call);
    // Bounded by the transport turn; unknown/native events never gain permission.
    if (name && this.calls.size < 4096) this.calls.set(id, name);
  }

  decide(value: unknown, sessionId: string | undefined): object {
    const deny = { outcome: { outcome: "cancelled" } };
    const request = object(value), call = object(request?.toolCall);
    if (!sessionId || request?.sessionId !== sessionId || !call) return deny;
    const id = call.toolCallId;
    if (typeof id !== "string" || this.consumed.has(id)) return deny;
    const expected = this.calls.get(id);
    const option = Array.isArray(request.options)
      ? request.options.find((x: unknown) => object(x)?.kind === "allow_once" && typeof object(x)?.optionId === "string") : undefined;
    if (!expected || !option) return deny;
    if (this.provider === "codex") {
      if (request._meta?.is_mcp_tool_approval !== true) return deny;
    } else if (this.tool(call, true) !== expected) return deny;
    this.calls.delete(id); this.consumed.add(id);
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
}
