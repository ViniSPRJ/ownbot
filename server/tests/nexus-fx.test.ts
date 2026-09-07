import { expect, test } from "bun:test";
import {
  createNexusFxCallTool,
  listTools,
  nexusFxSshArgs,
  type NexusFxOwner,
} from "../src/plugins/nexus-fx";
import { resolveServerUrl } from "../src/plugins/catalogue";

const NOW = Date.parse("2026-09-07T23:00:00Z");
const owner: NexusFxOwner = {
  host: "nexus-ops-vps.tail3c3777.ts.net",
  expectedHost: "nexus-ops-vps.tail3c3777.ts.net",
  sshUser: "ownbot-fx-reader",
  identityFile: "/private/key",
  knownHostsFile: "/private/known_hosts",
};
const connection = { actorId: "owner", url: "builtin://nexus-fx" };
const snapshot = () => ({
  schemaVersion: 1,
  observedAt: "2026-09-07T22:59:45Z",
  host: owner.expectedHost,
  source: "codex-fx",
  status: "ok",
  warnings: [],
  receipts: [
    {
      id: "receipt-1",
      symbol: "EURUSD",
      source: "codex-fx",
      state: "HOLD",
      warnings: [],
      quote: {
        valid: false,
        invalidReason: "quote_stale",
        tickAgeSeconds: 5000,
      },
    },
  ],
});
function setup(output: unknown = snapshot()) {
  const calls: string[][] = [];
  const tool = createNexusFxCallTool({
    ownerFor: (id) => {
      if (id !== "owner") throw new Error("wrong owner");
      return owner;
    },
    run: async (args) => {
      calls.push(args);
      return typeof output === "string" ? output : JSON.stringify(output);
    },
    now: () => NOW,
  });
  return { calls, tool };
}

test("Nexus catalogue exposes only read status", async () => {
  expect(resolveServerUrl("nexus-fx")?.url).toBe("builtin://nexus-fx");
  expect((await listTools()).map((t) => t.name)).toEqual(["status"]);
});
test("dedicated SSH args cannot inherit agent, config, forwarding or arbitrary command", () => {
  const args = nexusFxSshArgs(owner);
  expect(args.slice(0, 3)).toEqual(["-F", "/dev/null", "-T"]);
  expect(args.slice(3, 5)).toEqual(["-p", "22224"]);
  for (const option of [
    "BatchMode=yes",
    "IdentitiesOnly=yes",
    "StrictHostKeyChecking=yes",
    "IdentityAgent=none",
    "ClearAllForwardings=yes",
    "ForwardAgent=no",
    "PermitLocalCommand=no",
    "UserKnownHostsFile=/private/known_hosts",
    "GlobalKnownHostsFile=/dev/null",
  ])
    expect(args).toContain(option);
  expect(args.slice(-4)).toEqual([
    "-l",
    "ownbot-fx-reader",
    owner.host,
    "ownbot-fx-status",
  ]);
});
test("host injection, public hosts, root identity and unpinned hosts are refused", () => {
  for (const host of [
    "-oProxyCommand=evil",
    "example.com",
    "192.168.1.1",
    "nexus-ops-vps.tail3c3777.ts.net;echo bad",
    "other.tail3c3777.ts.net",
  ])
    expect(() => nexusFxSshArgs({ ...owner, host })).toThrow();
  expect(() =>
    nexusFxSshArgs({ ...owner, sshUser: "root" } as unknown as NexusFxOwner),
  ).toThrow();
  expect(() =>
    nexusFxSshArgs({ ...owner, identityFile: "relative" }),
  ).toThrow();
});
test("returns original receipts with observation time, never interprets HOLD as healthy trading", async () => {
  const { tool, calls } = setup();
  const result = await tool(connection, "status", {});
  expect(result.isError).toBe(false);
  expect(calls).toHaveLength(1);
  const data = JSON.parse(result.text);
  expect(data.readOnly).toBe(true);
  expect(data.snapshotAgeSeconds).toBe(15);
  expect(data.receipts[0].state).toBe("HOLD");
  expect(data.receipts[0].quote.valid).toBe(false);
  expect(data.receipts[0].quote.tickAgeSeconds).toBe(5000);
});
test("no user, another user, arbitrary tool and model command args never execute", async () => {
  for (const [conn, name, args] of [
    [{ url: connection.url }, "status", {}],
    [{ ...connection, actorId: "other" }, "status", {}],
    [connection, "submit_fx_decision", {}],
    [connection, "status", { command: "restart" }],
    [connection, "status", { host: "evil" }],
  ] as const) {
    const { tool, calls } = setup();
    expect((await tool(conn, name, args)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  }
});
test("stale snapshot is visibly unknown and original timestamp retained", async () => {
  const stale = { ...snapshot(), observedAt: "2026-09-07T22:00:00Z" };
  const { tool } = setup(stale);
  const result = await tool(connection, "status", {});
  expect(result.isError).toBe(false);
  const data = JSON.parse(result.text);
  expect(data.status).toBe("unknown");
  expect(data.observedAt).toBe(stale.observedAt);
  expect(data.warnings).toContain("snapshot_stale");
});
test("wrong host, invalid schema, future dates and large payloads are refused", async () => {
  for (const output of [
    { ...snapshot(), host: "wrong" },
    { ...snapshot(), observedAt: "2026-09-08T00:00:00Z" },
    { ...snapshot(), status: "profitable" },
    { ...snapshot(), receipts: Array(6).fill(snapshot().receipts[0]) },
    "x".repeat(20 * 1024 + 1),
    "bad json",
  ]) {
    const { tool } = setup(output);
    expect((await tool(connection, "status", {})).isError).toBe(true);
  }
});
test("unreviewed exporter fields are stripped before model sees snapshot", async () => {
  const data = {
    ...snapshot(),
    token: "secret",
    receipts: [
      {
        ...snapshot().receipts[0],
        internalLog: "private contents",
        quote: { valid: true, accountPassword: "secret" },
      },
    ],
  };
  const { tool } = setup(data);
  const result = await tool(connection, "status", {});
  expect(result.isError).toBe(false);
  expect(result.text).not.toContain("secret");
  expect(result.text).not.toContain("private contents");
});
test("transport errors are sanitized and do not look like a successful unknown receipt", async () => {
  const tool = createNexusFxCallTool({
    ownerFor: () => owner,
    run: async () => {
      throw new Error("private key file secret contents");
    },
  });
  const result = await tool(connection, "status", {});
  expect(result.isError).toBe(true);
  expect(result.text).not.toContain("secret");
  expect(result.text).toContain("desconhecido");
});
