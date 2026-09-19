import { z } from "zod";
import { readResource, type McpCallResult, type McpTool } from "./mcp";
import { runOnyxCliSearch } from "./onyx-cli";
import * as rest from "./onyx-rest";

const querySchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();
const sourceSchema = z
  .object({
    resource: z
      .enum(["indexed_sources", "document_sets"])
      .default("indexed_sources"),
  })
  .strict();
const refused = (): McpCallResult => ({
  text: "Onyx indisponível ou acesso recusado para esta conta. Nenhuma consulta concluída foi confirmada.",
  isError: true,
  truncated: false,
});
export const listNeedsCredential = false;
export async function listTools(): Promise<McpTool[]> {
  const [search] = await rest.listTools();
  return [
    search!,
    {
      name: "cli_search",
      description:
        "Search the person's Onyx knowledge base through the official Onyx CLI. Returns cited evidence without invoking an Onyx answer or local language model. Use for an explicit CLI search; otherwise prefer search.",
      inputSchema: search!.inputSchema,
    },
    {
      name: "sources",
      description:
        "Read accessible indexed sources or document sets from the official Onyx MCP server, as the current person. This lists knowledge coverage; it does not search document content or prove completeness.",
      inputSchema: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: ["indexed_sources", "document_sets"],
            default: "indexed_sources",
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

/** Keep the native MCP endpoint on the same Tailnet host as the mapped Onyx API. */
export function onyxMcpUrl(owner: rest.OnyxOwner): string {
  const base = new URL(rest.onyxBaseUrl(owner.baseUrl));
  const url = new URL(owner.mcpUrl ?? "invalid:");
  rest.onyxBaseUrl(`${url.protocol}//${url.host}`);
  if (
    url.hostname !== base.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/mcp", "/mcp/"].includes(url.pathname)
  )
    throw new Error("Invalid MCP endpoint");
  return url.toString();
}

export function createOnyxKnowledgeTools(
  deps = {
    ownerFor: rest.ownerFor,
    tokenFor: rest.privateFile,
    send: fetch,
    search: rest.callTool,
    readResource,
    runCli: runOnyxCliSearch,
  },
) {
  return async (
    connection: { actorId?: string; url: string },
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> => {
    if (name === "search") return deps.search(connection, name, args);
    try {
      if (!connection.actorId) return refused();
      const parsed =
        name === "cli_search"
          ? querySchema.parse(args)
          : name === "sources"
            ? sourceSchema.parse(args)
            : null;
      if (!parsed) return refused();
      const owner = deps.ownerFor(connection.actorId);
      const base = rest.onyxBaseUrl(owner.baseUrl);
      const token = deps.tokenFor(owner.tokenFile).trim();
      if (!token || /[\r\n]/.test(token)) return refused();
      const response = await deps.send(`${base}/me`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return refused();
      const identity = z
        .object({ id: z.string(), is_active: z.boolean().optional() })
        .parse(await response.json());
      if (identity.id !== owner.onyxUserId || identity.is_active === false)
        return refused();
      if (name === "sources" && "resource" in parsed)
        return await deps.readResource(
          { url: onyxMcpUrl(owner), token },
          `resource://${parsed.resource}`,
        );
      if (name === "cli_search" && "query" in parsed && owner.cliCommand)
        return await deps.runCli({
          command: owner.cliCommand,
          query: parsed.query,
          retrieve: () => deps.search(connection, "search", parsed),
        });
      return refused();
    } catch {
      return refused();
    }
  };
}
export const callTool = createOnyxKnowledgeTools();
