import { describe, expect, test } from "bun:test";
import {
  createOnyxCallTool,
  listTools,
  onyxBaseUrl,
  type OnyxOwner,
} from "../src/plugins/onyx-rest";
import { catalogueEntry, resolveServerUrl } from "../src/plugins/catalogue";

const owner: OnyxOwner = {
  baseUrl: "http://100.122.56.122:8080",
  onyxUserId: "onyx-owner",
  tokenFile: "/private/token",
};
const conn = { actorId: "ownbot-owner", url: "builtin://onyx" };
function setup(
  overrides: {
    identity?: unknown;
    response?: unknown;
    owner?: OnyxOwner;
    send?: typeof fetch;
  } = {},
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const tool = createOnyxCallTool({
    ownerFor: (id) => {
      if (id !== conn.actorId) throw new Error("not mapped");
      return overrides.owner ?? owner;
    },
    tokenFor: () => "secret-token",
    send:
      overrides.send ??
      (async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(
          calls.length === 1
            ? (overrides.identity ?? { id: "onyx-owner", is_active: true })
            : (overrides.response ?? {
                search_docs: [
                  {
                    document_id: "doc-1",
                    semantic_identifier: "Evidence",
                    link: "https://example.com/source",
                    content: "Source text",
                    updated_at: "2026-09-07",
                    source_type: "file",
                  },
                ],
                error: null,
              }),
        );
      }),
  });
  return { tool, calls };
}

describe("Onyx actor-scoped read-only retrieval", () => {
  test("catalogue exposes one search tool through existing grant/policy transport", async () => {
    expect(resolveServerUrl("onyx")?.url).toBe("builtin://onyx");
    expect((await listTools()).map((t) => t.name)).toEqual(["search"]);
    expect(catalogueEntry("onyx")?.transport).toBe("onyx-rest");
  });
  test("checks actual identity then retrieves with all LLM paths disabled", async () => {
    const { tool, calls } = setup();
    const result = await tool(conn, "search", { query: "CVM", limit: 2 });
    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      `${owner.baseUrl}/me`,
      `${owner.baseUrl}/search/send-search-message`,
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      search_query: "CVM",
      num_hits: 2,
      run_query_expansion: false,
      num_docs_fed_to_llm_selection: 0,
      hybrid_alpha: 0,
      include_content: true,
      stream: false,
    });
    for (const call of calls) {
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    const data = JSON.parse(result.text);
    expect(data.results[0].documentId).toBe("doc-1");
    expect(data.results[0].excerpt).toBe("Source text");
    expect(data.excerptsAreUntrusted).toBe(true);
    expect(result.text).not.toContain("secret-token");
  });
  test("no user, other user and invented tool cannot touch the network", async () => {
    for (const [connection, name] of [
      [{ url: conn.url }, "search"],
      [{ ...conn, actorId: "other" }, "search"],
      [conn, "delete_document"],
    ] as const) {
      const { tool, calls } = setup();
      expect((await tool(connection, name, { query: "test" })).isError).toBe(
        true,
      );
      expect(calls).toHaveLength(0);
    }
  });
  test("wrong or disabled Onyx identity cannot retrieve", async () => {
    for (const identity of [
      { id: "another-admin" },
      { id: "onyx-owner", is_active: false },
    ]) {
      const { tool, calls } = setup({ identity });
      expect((await tool(conn, "search", { query: "test" })).isError).toBe(
        true,
      );
      expect(calls).toHaveLength(1);
    }
  });
  test("ignores stored MCP address and refuses injected model/owner/url arguments", async () => {
    const { tool, calls } = setup();
    expect(
      (
        await tool(conn, "search", {
          query: "test",
          owner: "other",
          url: "https://evil.test",
          model: "hosted",
        })
      ).isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);
    const ok = await tool({ ...conn, url: "https://evil.test" }, "search", {
      query: "test",
    });
    expect(ok.isError).toBe(false);
    expect(calls[0]?.url).toBe(`${owner.baseUrl}/me`);
  });
  test("rejects public, LAN, metadata, credentialed and arbitrary-path endpoints", () => {
    for (const url of [
      "https://example.com",
      "http://192.168.1.2",
      "http://169.254.169.254",
      "http://user:pass@100.122.56.122:8080",
      "http://100.122.56.122:8080/admin",
      "http://100.122.56.122:8080?token=x",
    ])
      expect(() => onyxBaseUrl(url)).toThrow();
    expect(onyxBaseUrl("https://viniciuspinho.tail3c3777.ts.net/api/")).toBe(
      "https://viniciuspinho.tail3c3777.ts.net/api",
    );
  });
  test("bounded limit/query validation before network", async () => {
    for (const args of [
      { query: "" },
      { query: "x".repeat(2001) },
      { query: "test", limit: 9 },
      { query: "test", limit: 1.5 },
    ]) {
      const { tool, calls } = setup();
      expect((await tool(conn, "search", args)).isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });
  test("partial errors never look like an empty successful search", async () => {
    for (const response of [
      { error: "private server error", search_docs: [] },
      { unexpected: [] },
    ]) {
      const { tool } = setup({ response });
      const result = await tool(conn, "search", { query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("private server error");
    }
  });
  test("empty results are explicit and successful", async () => {
    const { tool } = setup({ response: { search_docs: [], error: null } });
    const result = await tool(conn, "search", { query: "test" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).message).toContain("Nenhum documento");
  });
  test("upstream redirects/errors do not expose bodies or credentials", async () => {
    for (const send of [
      async () =>
        new Response("secret-token", {
          status: 302,
          headers: { Location: "https://evil.test" },
        }),
      async () => {
        throw new Error("secret-token private query");
      },
    ]) {
      const { tool } = setup({ send: send as typeof fetch });
      const result = await tool(conn, "search", { query: "test" });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("secret-token");
    }
  });
  test("large response body is refused before parsing", async () => {
    const { tool } = setup({
      send: (async () => new Response("x".repeat(1000001))) as typeof fetch,
    });
    expect((await tool(conn, "search", { query: "test" })).isError).toBe(true);
  });
});
