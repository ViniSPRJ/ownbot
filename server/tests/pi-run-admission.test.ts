import { expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import type { Database } from "../src/db/client";
import { piRunAdmissionRefusal } from "../src/plugins/pi-run-admission";
import { createPluginStore } from "../src/plugins/store";

test("both local Pi runs require true background and a stable worker-compatible key", () => {
  for (const ref of ["pi-m4/pi_run", "pi-m5/pi_run"]) {
    for (const args of [
      {},
      { background: false, idempotencyKey: "task-1" },
      { background: "true", idempotencyKey: "task-1" },
      { background: true },
      { background: true, idempotencyKey: " " },
      { background: true, idempotencyKey: "x".repeat(257) },
      { background: true, idempotencyKey: "x\ny" },
      { background: true, idempotencyKey: "x\ry" },
      { background: true, idempotencyKey: "x\0y" },
    ])
      expect(piRunAdmissionRefusal(ref, args)).toContain("background:true");
    for (const key of ["task-1", "tarefa:crédito/2026-09-07", "x".repeat(256)])
      expect(
        piRunAdmissionRefusal(ref, { background: true, idempotencyKey: key }),
      ).toBeNull();
  }
});
test("all other MCP refs preserve existing sync semantics", () => {
  for (const ref of [
    "pi-m4/pi_status",
    "pi-m5/pi_status",
    "other/pi_run",
    "pi-m4-extra/pi_run",
    "pi-m4/pi_run/extra",
    "pi-m4/PI_RUN",
  ])
    expect(piRunAdmissionRefusal(ref, {})).toBeNull();
});

/** Exercise the actual store call path; only its database and vendor I/O are recording doubles. */
function harness(
  ref: string,
  options: {
    granted?: boolean;
    policy?: ActionPolicy;
    credential?: boolean;
  } = {},
) {
  const [serverId, toolName] = ref.split("/");
  const rows = [
    options.granted === false ? [] : [{ ref }],
    [
      {
        id: serverId,
        provenance: "custom",
        url: "https://worker.example/mcp",
        credentialId: options.credential ? "credential-id" : null,
      },
    ],
    [{ name: toolName, inputSchema: {} }],
  ];
  let reads = 0;
  const audit: AuditEventInput[] = [];
  const vendorCalls: Record<string, unknown>[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  const row = rows.shift();
                  if (!row) throw new Error("Unexpected database read");
                  return Promise.resolve(row);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  const store = createPluginStore({
    database: db,
    auditStore: {
      insert: async (event) => {
        audit.push(event);
      },
    },
    credentials: {
      readSecret: async () => {
        reads++;
        throw new Error("Credential access must not happen");
      },
      create: async () => {
        throw new Error("Unexpected create");
      },
      updateSecret: async () => {
        throw new Error("Unexpected update");
      },
      revoke: async () => {
        throw new Error("Unexpected revoke");
      },
    },
    encryptionKey: "x".repeat(44),
    policy: () =>
      options.policy ?? { mode: "enforce", allow: ["true"], deny: [] },
    callVendor: async (_connection, _tool, args) => {
      vendorCalls.push(args);
      return { text: "accepted", isError: false };
    },
  });
  return {
    call: (args: Record<string, unknown>) =>
      store.callTool({
        ref,
        args,
        botId: "test-pi-agent",
        actorId: "test-owner",
      }),
    audit,
    vendorCalls,
    credentialReads: () => reads,
  };
}

test("actual plugin store refuses sync Pi before vault/network and records unexecuted refusal", async () => {
  for (const ref of ["pi-m4/pi_run", "pi-m5/pi_run"]) {
    const h = harness(ref, { credential: true });
    await expect(h.call({ task: "private task" })).rejects.toThrow(
      "background:true",
    );
    expect(h.vendorCalls).toHaveLength(0);
    expect(h.credentialReads()).toBe(0);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.eventType).toBe("mcp.call_rejected");
    expect(h.audit[0]?.payload.refusal).toBe("pi_durable_submission_required");
    expect(h.audit[0]?.payload.decision).toMatchObject({ carriedOut: false });
    expect(JSON.stringify(h.audit)).not.toContain("private task");
  }
});
test("grants and policy still reject before the Pi contract is considered", async () => {
  const missing = harness("pi-m4/pi_run", { granted: false });
  await expect(missing.call({})).rejects.toThrow("has not been given");
  expect(missing.audit[0]?.payload.refusal).toBe("not_granted");
  const denied = harness("pi-m5/pi_run", {
    policy: { mode: "enforce", allow: ["true"], deny: ["true"] },
  });
  await expect(denied.call({})).rejects.toThrow();
  expect(denied.audit[0]?.payload.refusal).toBeUndefined();
  expect(denied.vendorCalls).toHaveLength(0);
});
test("policy dry-run cannot accidentally enable synchronous Pi work", async () => {
  const h = harness("pi-m4/pi_run", {
    policy: { mode: "dry-run", allow: ["true"], deny: ["true"] },
  });
  await expect(h.call({})).rejects.toThrow("background:true");
  expect(h.vendorCalls).toHaveLength(0);
  expect(h.audit.at(-1)?.payload.refusal).toBe(
    "pi_durable_submission_required",
  );
});
test("valid durable args and key are forwarded unchanged; other refs are unaffected", async () => {
  for (const ref of [
    "pi-m4/pi_run",
    "pi-m5/pi_run",
    "other/pi_run",
    "pi-m4/pi_status",
  ]) {
    const h = harness(ref);
    const args =
      ref.endsWith("/pi_run") && ref.startsWith("pi-m")
        ? { task: "same task", background: true, idempotencyKey: "same-key" }
        : { task: "legacy sync" };
    expect((await h.call(args)).isError).toBe(false);
    expect(h.vendorCalls).toEqual([args]);
    expect(h.audit.at(-1)?.eventType).toBe("mcp.call_succeeded");
  }
});
