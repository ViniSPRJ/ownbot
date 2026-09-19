import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { McpCallResult } from "./mcp";

/**
 * The official CLI normally uses Onyx's LLM-assisted /search endpoint. Give it a
 * single-call loopback retrieval endpoint instead: the existing actor-scoped,
 * LLM-free search supplies evidence; Codex/Cursor alone composes the answer.
 * The CLI gets an ephemeral capability, never the user's Onyx PAT or server env.
 */
export async function runOnyxCliSearch(input: {
  command: string;
  query: string;
  retrieve: () => Promise<McpCallResult>;
}): Promise<McpCallResult> {
  const directory = await mkdtemp(join(tmpdir(), "ownbot-onyx-cli-"));
  const bearer = randomBytes(32).toString("hex");
  let called = false;
  let retrieval: McpCallResult | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 8192,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${bearer}`)
        return new Response(null, { status: 401 });
      if (
        new URL(request.url).pathname !== "/search" ||
        request.method !== "POST" ||
        called
      )
        return new Response(null, { status: 404 });
      const body: unknown = await request.json().catch(() => null);
      if (
        !body ||
        typeof body !== "object" ||
        !("query" in body) ||
        body.query !== input.query
      )
        return new Response(null, { status: 400 });
      called = true;
      retrieval = await input.retrieve();
      if (retrieval.isError)
        return Response.json(
          { detail: "Retrieval unavailable" },
          { status: 502 },
        );
      const data = JSON.parse(retrieval.text);
      return Response.json({
        results: data.results.map((doc: Record<string, unknown>) => ({
          document_id: doc.documentId,
          title: doc.title,
          url: doc.link,
          content: doc.excerpt,
          source_type: doc.source,
          updated_at: doc.updatedAt,
        })),
      });
    },
  });
  try {
    const { stdout } = await promisify(execFile)(
      input.command,
      [
        "search",
        "--no-query-expansion",
        "--max-output",
        "16000",
        "--",
        input.query,
      ],
      {
        cwd: directory,
        timeout: 35000,
        maxBuffer: 1000000,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: directory,
          XDG_CONFIG_HOME: directory,
          TMPDIR: directory,
          ONYX_SERVER_URL: `http://127.0.0.1:${server.port}`,
          ONYX_API_PREFIX: "",
          ONYX_PAT: bearer,
        },
      },
    );
    const data: unknown = JSON.parse(stdout);
    if (
      !called ||
      !retrieval ||
      retrieval.isError ||
      !data ||
      typeof data !== "object" ||
      !("results" in data) ||
      !Array.isArray(data.results)
    )
      throw new Error("Invalid CLI result");
    // Return the canonical IDs as well as the official CLI's results; never expose temp paths.
    return {
      text: JSON.stringify({
        source: "Onyx CLI",
        retrieval: "keyword; no Onyx LLM",
        results: data.results,
        evidence: JSON.parse(retrieval.text).results,
      }),
      isError: false,
      truncated: false,
    };
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
