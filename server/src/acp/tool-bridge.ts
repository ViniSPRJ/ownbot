import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";

const MAX_BODY_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-03-26";

export type ToolBridge = {
  descriptor: {
    type: "http";
    name: "ownbot";
    url: string;
    headers: { name: string; value: string }[];
  };
  close: () => Promise<void>;
};

/** Per-run capability bridge: only the supplied grants can execute here. */
export async function createToolBridge(tools: readonly GrantedTool[]): Promise<ToolBridge> {
  const grants = new Map<string, GrantedTool>();
  const definitions = tools.map((tool) => {
    if (grants.has(tool.name)) throw new Error("Duplicate ACP tool name");
    grants.set(tool.name, tool);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.parameters, { io: "input" }),
    };
  });
  const authorization = Buffer.from(`Bearer ${randomBytes(32).toString("hex")}`);
  const reply = (payload: unknown, status = 200) => Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
  const error = (id: unknown, code: number, message: string) => reply({
    jsonrpc: "2.0", id, error: { code, message },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      const presented = Buffer.from(request.headers.get("authorization") ?? "");
      if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) {
        return reply({ error: "Unauthorized" }, 401);
      }
      // Browser callers are not part of the CLI trust boundary.
      if (request.headers.has("origin")) return reply({ error: "Forbidden origin" }, 403);
      if (new URL(request.url).pathname !== "/mcp") return reply({ error: "Not found" }, 404);
      if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return reply({ error: "Expected JSON" }, 415);
      }
      let body: Record<string, unknown>;
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_BODY_BYTES) return reply({ error: "Request too large" }, 413);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(null, -32600, "Invalid request");
        body = parsed as Record<string, unknown>;
      } catch {
        return error(null, -32700, "Invalid JSON");
      }
      const id = body.id ?? null;
      if (body.jsonrpc !== "2.0" || typeof body.method !== "string" ||
          (id !== null && typeof id !== "string" && typeof id !== "number")) {
        return error(null, -32600, "Invalid request");
      }
      if (body.method === "notifications/initialized" && body.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (body.id === undefined) return error(null, -32600, "Request id required");
      const result = (value: unknown) => reply({ jsonrpc: "2.0", id, result: value });
      switch (body.method) {
        case "initialize":
          return result({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ownbot", version: "1.0.0" } });
        case "ping":
          return result({});
        case "tools/list":
          return result({ tools: definitions });
        case "tools/call": {
          const params = body.params as { name?: unknown; arguments?: unknown } | undefined;
          if (!params || typeof params.name !== "string") return error(id, -32602, "Invalid tool parameters");
          const tool = grants.get(params.name);
          if (!tool) return error(id, -32602, "Tool not granted");
          const validated = await tool.parameters.safeParseAsync(params.arguments ?? {});
          if (!validated.success) return error(id, -32602, "Invalid tool arguments");
          try {
            return result({ content: [{ type: "text", text: await tool.execute(validated.data) }] });
          } catch {
            // Exceptions can contain vendor credentials, private URLs, or request bodies.
            return result({ isError: true, content: [{ type: "text", text: "Tool execution failed" }] });
          }
        }
        default:
          return error(id, -32601, "Method not found");
      }
    },
  });
  return {
    descriptor: {
      type: "http", name: "ownbot", url: `http://127.0.0.1:${server.port}/mcp`,
      headers: [{ name: "Authorization", value: authorization.toString() }],
    },
    close: async () => { await server.stop(true); },
  };
}
