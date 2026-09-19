import { describe, test, expect } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOnyxKnowledgeTools,
  listTools,
  onyxMcpUrl,
} from "../src/plugins/onyx-knowledge";
import { runOnyxCliSearch } from "../src/plugins/onyx-cli";
import type { OnyxOwner } from "../src/plugins/onyx-rest";

const owner: OnyxOwner = {
  baseUrl: "http://100.122.56.122:8080",
  onyxUserId: "onyx-owner",
  tokenFile: "/private/token",
  mcpUrl: "http://100.122.56.122:8090/",
  cliCommand: "/opt/onyx-cli",
};
const evidence = {
  text: JSON.stringify({
    results: [
      {
        documentId: "doc-1",
        title: "Evidence",
        link: "https://example.com/source",
        excerpt: "Grounded fact",
        source: "file",
        updatedAt: null,
      },
    ],
  }),
  isError: false,
  truncated: false,
};
const conn = { actorId: "owner", url: "builtin://onyx" };
function setup(identity = "onyx-owner") {
  const calls: string[] = [];
  const tool = createOnyxKnowledgeTools({
    ownerFor: (id) => {
      if (id !== "owner") throw new Error("not mapped");
      return owner;
    },
    tokenFor: () => "private-pat",
    send: (async () => {
      calls.push("identity");
      return Response.json({ id: identity });
    }) as typeof fetch,
    search: async () => {
      calls.push("search");
      return evidence;
    },
    readResource: async (connection, uri) => {
      calls.push(uri);
      expect(connection.token).toBe("private-pat");
      return evidence;
    },
    runCli: async (input) => {
      calls.push("cli");
      return input.retrieve();
    },
  });
  return { tool, calls };
}

describe("Onyx MCP and CLI identity boundary", () => {
  test("offers only knowledge reads", async () => {
    expect((await listTools()).map((t) => t.name)).toEqual([
      "search",
      "cli_search",
      "sources",
    ]);
  });
  test("checks identity before official MCP resources or CLI search", async () => {
    const { tool, calls } = setup();
    expect(
      (await tool(conn, "sources", { resource: "document_sets" })).isError,
    ).toBe(false);
    expect((await tool(conn, "cli_search", { query: "CVM" })).isError).toBe(
      false,
    );
    expect(calls).toEqual([
      "identity",
      "resource://document_sets",
      "identity",
      "cli",
      "search",
    ]);
  });
  test("unmapped users, mismatched tokens, injected arguments and write commands are refused", async () => {
    for (const [connection, name, args] of [
      [{ ...conn, actorId: "other" }, "sources", {}],
      [conn, "sources", { resource: "users" }],
      [conn, "cli_search", { query: "x", command: "delete" }],
      [conn, "deploy", {}],
    ] as const) {
      const { tool, calls } = setup();
      expect((await tool(connection, name, args)).isError).toBe(true);
      expect(calls).toEqual([]);
    }
    const { tool, calls } = setup("other-person");
    expect((await tool(conn, "cli_search", { query: "x" })).isError).toBe(true);
    expect(calls).toEqual(["identity"]);
  });
  test("MCP credentials cannot leave the mapped Onyx Tailnet host", () => {
    expect(onyxMcpUrl(owner)).toBe(owner.mcpUrl!);
    for (const mcpUrl of [
      "http://100.92.206.45:8090/",
      "https://evil.test",
      "http://u:p@100.122.56.122:8090/",
      "http://100.122.56.122:8090/?token=x",
    ])
      expect(() => onyxMcpUrl({ ...owner, mcpUrl })).toThrow();
  });
});

test("CLI runs with an ephemeral retrieval capability, isolated config, literal query and preserved evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onyx-cli-fixture-"));
  const command = join(directory, "onyx-cli");
  const query = "--debug $(touch should-not-exist); CVM";
  await writeFile(
    command,
    `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args[0]!=="search"||args.at(-2)!=="--"||process.env.ONYX_PAT==="private-pat")process.exit(2);\nconst response=await fetch(process.env.ONYX_SERVER_URL+"/search",{method:"POST",headers:{Authorization:"Bearer "+process.env.ONYX_PAT,"Content-Type":"application/json"},body:JSON.stringify({query:args.at(-1)})});\nconsole.log(await response.text());\n`,
  );
  await chmod(command, 0o700);
  let retrieved = 0;
  try {
    const result = await runOnyxCliSearch({
      command,
      query,
      retrieve: async () => {
        retrieved++;
        return evidence;
      },
    });
    expect(result.isError).toBe(false);
    expect(retrieved).toBe(1);
    expect(JSON.parse(result.text).evidence[0].documentId).toBe("doc-1");
    expect(JSON.parse(result.text).results[0].content).toBe("Grounded fact");
    expect(result.text).not.toContain("private-pat");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
