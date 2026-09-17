import { expect, test } from "bun:test";
import { createDurableExecutorRegistry } from "../src/agents/durable-executors";
import type { AuditEventInput } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import type { Database } from "../src/db/client";
import { piRunAdmissionRefusal } from "../src/plugins/pi-run-admission";
import { createPluginStore } from "../src/plugins/store";

const labExecutors = createDurableExecutorRegistry({
  version: 1,
  executors: [
    {
      id: "lab-worker",
      protocol: "pi-durable-v1",
      submitTool: "lab/pi_run",
      statusTool: "lab/pi_status",
    },
  ],
});

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
    expect(piRunAdmissionRefusal(ref, {})).toContain(
      ref.replace("/pi_run", "/pi_status"),
    );
  }
});
test("all other non-pi_run MCP refs preserve existing sync semantics", () => {
  for (const ref of [
    "pi-m4/pi_status",
    "pi-m5/pi_status",
    "pi-m4/pi_run/extra",
    "pi-m4/PI_RUN",
    "lab/submit_job",
  ])
    expect(piRunAdmissionRefusal(ref, {})).toBeNull();
});
test("unregistered refs ending /pi_run are refused even with a valid key", () => {
  const valid = { background: true, idempotencyKey: "task-1" };
  for (const ref of ["other/pi_run", "pi-m4-extra/pi_run", "lab/pi_run"]) {
    const refusal = piRunAdmissionRefusal(ref, valid);
    expect(refusal).toMatch(/executor not registered/i);
    expect(refusal).not.toContain("idempotencyKey");
    expect(piRunAdmissionRefusal(ref, {})).toMatch(/executor not registered/i);
  }
  expect(piRunAdmissionRefusal("pi-m4-extra/pi_run", valid)).not.toBeNull();
});

/** Exercise the actual store call path; only its database and vendor I/O are recording doubles. */
function harness(
  ref: string,
  options: {
    granted?: boolean;
    policy?: ActionPolicy;
    credential?: boolean;
    executors?: ReturnType<typeof createDurableExecutorRegistry>;
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
    executors: options.executors,
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
    "pi-m4/pi_status",
    "lab/submit_job",
  ]) {
    const h = harness(ref);
    const args = ref.endsWith("/pi_run")
      ? { task: "same task", background: true, idempotencyKey: "same-key" }
      : { task: "legacy sync" };
    expect((await h.call(args)).isError).toBe(false);
    expect(h.vendorCalls).toEqual([args]);
    expect(h.audit.at(-1)?.eventType).toBe("mcp.call_succeeded");
  }
});
test("custom registered submit refs reuse the durable contract; prefix lookalikes are not trusted", () => {
  expect(piRunAdmissionRefusal("lab/pi_run", {}, labExecutors)).toContain(
    "lab/pi_status",
  );
  expect(
    piRunAdmissionRefusal(
      "lab/pi_run",
      { background: true, idempotencyKey: "task-1" },
      labExecutors,
    ),
  ).toBeNull();
  const removed = piRunAdmissionRefusal("pi-m4/pi_run", {}, labExecutors);
  expect(removed).toMatch(/executor not registered/i);
  expect(removed).not.toContain("idempotencyKey");
  for (const ref of ["lab/SUBMIT_JOB", "lab/pi_status", "lab/submit_job"])
    expect(piRunAdmissionRefusal(ref, {}, labExecutors)).toBeNull();
  for (const ref of ["lab-extra/pi_run", "other/pi_run", "pi-m4/pi_run"]) {
    const refusal = piRunAdmissionRefusal(
      ref,
      { background: true, idempotencyKey: "task-1" },
      labExecutors,
    );
    expect(refusal).toMatch(/executor not registered/i);
    expect(refusal).not.toContain("idempotencyKey");
  }
});
test("configured store refuses a registered custom submit before vault/network", async () => {
  const h = harness("lab/pi_run", {
    credential: true,
    executors: labExecutors,
  });
  await expect(h.call({ task: "private task" })).rejects.toThrow(
    "background:true",
  );
  expect(h.vendorCalls).toHaveLength(0);
  expect(h.credentialReads()).toBe(0);
  expect(h.audit).toHaveLength(1);
  expect(h.audit[0]?.eventType).toBe("mcp.call_rejected");
  expect(h.audit[0]?.payload.refusal).toBe("pi_durable_submission_required");
  expect(h.audit[0]?.payload.reason).toContain("lab/pi_status");
  expect(h.audit[0]?.payload.decision).toMatchObject({ carriedOut: false });
  expect(JSON.stringify(h.audit)).not.toContain("private task");
  const admitted = harness("lab/pi_run", { executors: labExecutors });
  const args = {
    task: "same task",
    background: true,
    idempotencyKey: "same-key",
  };
  expect((await admitted.call(args)).isError).toBe(false);
  expect(admitted.vendorCalls).toEqual([args]);
  const lookalike = harness("lab/submit_job", {
    executors: labExecutors,
  });
  expect((await lookalike.call({ task: "legacy sync" })).isError).toBe(false);
  expect(lookalike.vendorCalls).toEqual([{ task: "legacy sync" }]);
});
test("store refuses unknown and removed /pi_run refs before vault/network", async () => {
  const empty = createDurableExecutorRegistry({ version: 1, executors: [] });
  for (const [ref, executors] of [
    ["other/pi_run", undefined],
    ["pi-m4-extra/pi_run", undefined],
    ["pi-m4/pi_run", labExecutors],
    ["pi-m4/pi_run", empty],
    ["lab-extra/pi_run", labExecutors],
  ] as const) {
    const h = harness(ref, {
      credential: true,
      executors,
    });
    await expect(
      h.call({
        task: "private task",
        background: true,
        idempotencyKey: "same-key",
      }),
    ).rejects.toThrow(/executor not registered/i);
    expect(h.vendorCalls).toHaveLength(0);
    expect(h.credentialReads()).toBe(0);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.eventType).toBe("mcp.call_rejected");
    expect(h.audit[0]?.payload.refusal).toBe("pi_durable_submission_required");
    expect(h.audit[0]?.payload.reason).toMatch(/executor not registered/i);
    expect(h.audit[0]?.payload.reason).not.toContain("idempotencyKey");
    expect(h.audit[0]?.payload.decision).toMatchObject({ carriedOut: false });
    expect(JSON.stringify(h.audit)).not.toContain("private task");
  }
});
