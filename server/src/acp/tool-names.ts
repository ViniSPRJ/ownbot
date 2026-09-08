import { createHash } from "node:crypto";
import type { GrantedTool } from "../plugins/tools";
import type { AcpProvider } from "./permissions";

/** Grok's native MCP discovery omits tool names containing double underscores. */
export function acpToolsForProvider(
  provider: AcpProvider,
  tools: readonly GrantedTool[],
): { tools: readonly GrantedTool[]; guidance: string } {
  if (provider !== "grok") return { tools, guidance: "" };
  const names = new Set<string>();
  const mapped = tools.map((tool) => {
    const simple = tool.name.replace(/[^A-Za-z0-9]+/g, "_");
    // Include the canonical name's digest so connectors with similar slugs stay distinct.
    const name = simple === tool.name && simple.length <= 64
      ? simple
      : `${simple.slice(0, 47)}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 16)}`;
    if (names.has(name)) throw new Error("Duplicate ACP tool name");
    names.add(name);
    // Only the wire name changes. The capability, owner-bound executor, and audit ref do not.
    return name === tool.name ? tool : { ...tool, name };
  });
  return {
    tools: mapped,
    guidance: mapped.length ? [
      "Exact tool names for this Grok ACP session (use these names with use_tool):",
      ...mapped.map((tool) => `- ${tool.ref}: ownbot__${tool.name}`),
      "Use the exact name above; do not shorten it to the connector's operation name.",
      "A failed tool search or an incorrect-name error is not evidence that a listed grant is missing.",
    ].join("\n") : "",
  };
}
