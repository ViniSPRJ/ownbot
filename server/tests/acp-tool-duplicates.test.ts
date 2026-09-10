import { expect, test } from "bun:test";
import { z } from "zod";
import { AcpPermissionGate } from "../src/acp/permissions";
import { createToolBridge } from "../src/acp/tool-bridge";
import { acpToolsForProvider } from "../src/acp/tool-names";
import type { GrantedTool } from "../src/plugins/tools";

/**
 * Two connectors, one tool name. `delegate-to-pi` grants `pi-m4/pi_run` and `pi-m5/pi_run`, and the
 * name the CLI sees is the connector's, not the ref, so both arrived as `pi_run`. The bridge refused
 * the second and the whole run died in the `tools` phase, reported as an authentication problem.
 */
const grant = (ref: string, answer: string): GrantedTool => ({
  name: ref.split("/")[1]!,
  ref,
  description: `Run a coding job on ${ref.split("/")[0]}.`,
  parameters: z.object({}).strict(),
  execute: async () => answer,
});

const call = async (
  bridge: Awaited<ReturnType<typeof createToolBridge>>,
  method: string,
  params?: unknown,
) => {
  const response = await fetch(bridge.descriptor.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(
        bridge.descriptor.headers.map((h) => [h.name, h.value]),
      ),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as {
    result: { tools: { name: string }[]; content: { text: string }[] };
    error: { message: string };
  };
};

test("a Bot granted the same tool on two connectors keeps both capabilities", async () => {
  const source = [
    grant("pi-m4/pi_run", "queued on the M4"),
    grant("pi-m5/pi_run", "queued on the M5"),
    grant("routines/list_routines", "the owner's routines"),
  ];
  for (const provider of ["codex", "claude", "pi", "grok"] as const) {
    const { tools } = acpToolsForProvider(provider, source);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(3);
    for (const tool of tools) expect(tool.name.length).toBeLessThanOrEqual(64);
    // The grant nobody collides with keeps the name the model already knows.
    expect(tools[2]!.name).toBe("list_routines");
    expect(tools.map((tool) => tool.ref)).toEqual(
      source.map((tool) => tool.ref),
    );
  }
});

test("each qualified name still executes only its own connector's grant", async () => {
  const source = [
    grant("pi-m4/pi_run", "queued on the M4"),
    grant("pi-m5/pi_run", "queued on the M5"),
  ];
  const { tools, guidance } = acpToolsForProvider("codex", source);
  const [m4, m5] = tools;
  // The model is told, because the skill's instructions name the tool `pi_run`.
  expect(guidance).toContain(`pi-m4/pi_run: ${m4!.name}`);
  expect(guidance).toContain(`pi-m5/pi_run: ${m5!.name}`);

  const bridge = await createToolBridge(tools);
  try {
    expect(
      (await call(bridge, "tools/list")).result.tools.map((t) => t.name),
    ).toEqual([m4!.name, m5!.name]);
    expect(
      (await call(bridge, "tools/call", { name: m4!.name, arguments: {} }))
        .result.content[0].text,
    ).toBe("queued on the M4");
    expect(
      (await call(bridge, "tools/call", { name: m5!.name, arguments: {} }))
        .result.content[0].text,
    ).toBe("queued on the M5");
    // The ambiguous short name resolves to neither, rather than to whichever won.
    expect(
      (await call(bridge, "tools/call", { name: "pi_run", arguments: {} }))
        .error.message,
    ).toBe("Tool not granted");
  } finally {
    await bridge.close();
  }

  const gate = new AcpPermissionGate(
    "codex",
    new Set(tools.map((t) => t.name)),
  );
  const toolCall = {
    toolCallId: "job-1",
    _meta: { is_mcp_tool_call: true },
    rawInput: { server: "ownbot", tool: m5!.name },
  };
  gate.observe({ ...toolCall, sessionUpdate: "tool_call", status: "pending" });
  expect(
    gate.decide(
      {
        sessionId: "session-A",
        _meta: { is_mcp_tool_approval: true },
        toolCall,
        options: [{ optionId: "once", kind: "allow_once" }],
      },
      "session-A",
    ),
  ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
});

/**
 * Two refs that sanitise to the same spelling must not race for the plain name: a run that loaded
 * its grants in a different order would otherwise rename a tool underneath a resumed CLI session.
 */
test("which grant gets which name does not depend on the order they arrived in", () => {
  const clashing = [
    grant("pi-m4/pi_run", "M4"),
    grant("pi_m4/pi_run", "the other M4 connector"),
    grant("pi-m5/pi_run", "M5"),
  ];
  const forwards = acpToolsForProvider("codex", clashing).tools;
  const backwards = acpToolsForProvider("codex", [...clashing].reverse()).tools;
  expect(new Set(forwards.map((t) => t.name)).size).toBe(3);
  expect(backwards.map((t) => t.name)).toEqual(
    [...forwards.map((t) => t.name)].reverse(),
  );
  // Neither of the two that sanitise alike may take the plain spelling.
  expect(forwards.map((t) => t.name)).not.toContain("pi_m4_pi_run");
  // The one nobody clashes with still gets the readable name.
  expect(forwards[2]!.name).toBe("pi_m5_pi_run");
});

test("the same grant listed twice is still an error, and a clash of qualified names cannot alias", () => {
  const twice = grant("pi-m4/pi_run", "queued on the M4");
  expect(() => acpToolsForProvider("codex", [twice, twice])).toThrow(
    "Duplicate ACP tool name",
  );
  // A third grant already holding the qualified spelling must not be shadowed by the fallback.
  const crowded = [
    grant("pi-m4/pi_run", "M4"),
    grant("pi-m5/pi_run", "M5"),
    { ...grant("other/x", "third"), name: "pi_m4_pi_run" },
  ];
  const names = acpToolsForProvider("codex", crowded).tools.map((t) => t.name);
  expect(new Set(names).size).toBe(3);
  expect(names[2]).toBe("pi_m4_pi_run");
});
