import { createHash } from "node:crypto";
import type { GrantedTool } from "../plugins/tools";
import type { AcpProvider } from "./permissions";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const simplify = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "_");

/**
 * One wire name per grant, when two connectors offer a tool of the same name.
 *
 * A grant carries two spellings: `ref` is `<server>/<tool>` and is unique by construction, while
 * `name` is the vendor's own and is not — `pi-m4/pi_run` and `pi-m5/pi_run` are two capabilities
 * both called `pi_run`. Only the name reaches the CLI, and `createToolBridge` refuses to register
 * the second one, so a Bot holding both grants failed every ACP run before it opened a session,
 * reported as an authentication or availability problem it never had.
 *
 * The collision is resolved where the whole session agrees on names — the bridge, the permission
 * gate and the prompt all read this result — by falling back to the ref for the colliding grants
 * only. A tool nobody collides with keeps the name the model already knows.
 *
 * Which grant gets which name never depends on the order they arrived in. Two refs that sanitise to
 * the same spelling (`pi-m4/pi_run` and `pi_m4/pi_run`) both take the digest form rather than
 * racing for the plain one, so a run that loaded its grants in a different order does not rename a
 * tool underneath a resumed CLI session.
 *
 * The same ref twice is different: that is one capability listed twice, with nothing to tell apart,
 * so it stays an error.
 */
function withUniqueNames(
  tools: readonly GrantedTool[],
): readonly GrantedTool[] {
  const byName = new Map<string, number>();
  for (const tool of tools)
    byName.set(tool.name, (byName.get(tool.name) ?? 0) + 1);
  if ([...byName.values()].every((count) => count === 1)) return tools;

  // Names nobody has to give up, and the sanitised refs more than one grant would claim.
  const taken = new Set<string>();
  const bySimpleRef = new Map<string, number>();
  for (const tool of tools) {
    if (byName.get(tool.name) === 1) taken.add(tool.name);
    else {
      const simple = simplify(tool.ref);
      bySimpleRef.set(simple, (bySimpleRef.get(simple) ?? 0) + 1);
    }
  }

  const refs = new Set<string>();
  return tools.map((tool) => {
    if (refs.has(tool.ref)) throw new Error("Duplicate ACP tool name");
    refs.add(tool.ref);
    if (byName.get(tool.name) === 1) return tool;
    const simple = simplify(tool.ref);
    const plain =
      simple.length <= 64 &&
      !taken.has(simple) &&
      bySimpleRef.get(simple) === 1;
    const name = plain ? simple : `${simple.slice(0, 47)}_${digest(tool.ref)}`;
    if (taken.has(name)) throw new Error("Duplicate ACP tool name");
    taken.add(name);
    // Only the wire name changes. The capability, owner-bound executor, and audit ref do not.
    return { ...tool, name };
  });
}

/** What the model is told when a grant is not offered under the name its connector gave it. */
function qualifiedGuidance(
  source: readonly GrantedTool[],
  mapped: readonly GrantedTool[],
): string {
  const renamed = mapped.filter(
    (tool, index) => tool.name !== source[index]?.name,
  );
  return renamed.length
    ? [
        "Two connectors offer a tool of the same name, so these grants are registered under a qualified name:",
        ...renamed.map((tool) => `- ${tool.ref}: ${tool.name}`),
        "Call the qualified name; the connector's short name is not registered in this session.",
      ].join("\n")
    : "";
}

/** Grok's native MCP discovery omits tool names containing double underscores. */
export function acpToolsForProvider(
  provider: AcpProvider,
  tools: readonly GrantedTool[],
): { tools: readonly GrantedTool[]; guidance: string } {
  const unique = withUniqueNames(tools);
  if (provider !== "grok") {
    return { tools: unique, guidance: qualifiedGuidance(tools, unique) };
  }
  const names = new Set<string>();
  const mapped = unique.map((tool) => {
    const simple = simplify(tool.name);
    // Include the canonical name's digest so connectors with similar slugs stay distinct.
    const name =
      simple === tool.name && simple.length <= 64
        ? simple
        : `${simple.slice(0, 47)}_${digest(tool.name)}`;
    if (names.has(name)) throw new Error("Duplicate ACP tool name");
    names.add(name);
    return name === tool.name ? tool : { ...tool, name };
  });
  return {
    tools: mapped,
    guidance: mapped.length
      ? [
          "Exact tool names for this Grok ACP session (use these names with use_tool):",
          ...mapped.map((tool) => `- ${tool.ref}: ownbot__${tool.name}`),
          "Use the exact name above; do not shorten it to the connector's operation name.",
          "A failed tool search or an incorrect-name error is not evidence that a listed grant is missing.",
        ].join("\n")
      : "",
  };
}
