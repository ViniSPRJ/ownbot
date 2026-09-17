import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableExecutorRegistry,
  DEFAULT_DURABLE_EXECUTORS,
  DURABLE_EXECUTOR_CONFIG_ERROR,
  loadDurableExecutors,
  resolveWatchExecutor,
} from "../src/agents/durable-executors";

const dir = mkdtempSync(join(tmpdir(), "ownbot-durable-executors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const valid = {
  version: 1 as const,
  executors: [
    {
      id: "lab-worker",
      protocol: "pi-durable-v1" as const,
      submitTool: "lab/pi_run",
      statusTool: "lab/pi_status",
    },
  ],
};

function write(name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

test("unset path keeps the shipped Pi M4 and M5 mapping", () => {
  expect(loadDurableExecutors()).toBe(DEFAULT_DURABLE_EXECUTORS);
  expect(loadDurableExecutors("")).toBe(DEFAULT_DURABLE_EXECUTORS);
  expect(DEFAULT_DURABLE_EXECUTORS.findById("pi-m4")).toEqual({
    id: "pi-m4",
    protocol: "pi-durable-v1",
    submitTool: "pi-m4/pi_run",
    statusTool: "pi-m4/pi_status",
  });
  expect(DEFAULT_DURABLE_EXECUTORS.findBySubmitTool("pi-m5/pi_run")?.id).toBe(
    "pi-m5",
  );
  expect(
    DEFAULT_DURABLE_EXECUTORS.findBySubmitTool("pi-m5/pi_status"),
  ).toBeUndefined();
});

test("provided config replaces the entire registry", () => {
  const path = write("replace.json", JSON.stringify(valid));
  const registry = loadDurableExecutors(path);
  expect(registry.findById("lab-worker")?.submitTool).toBe("lab/pi_run");
  expect(registry.findBySubmitTool("pi-m4/pi_run")).toBeUndefined();
  expect(registry.findById("pi-m5")).toBeUndefined();
});

test("lookups are exact refs, not vendor or pi_run wildcards", () => {
  const registry = createDurableExecutorRegistry(valid);
  for (const ref of [
    "lab/PI_RUN",
    "lab-extra/pi_run",
    "other/pi_run",
    "lab/pi_run/extra",
    "lab/pi",
    "pi_run",
    "pi-m4/pi_run",
  ])
    expect(registry.findBySubmitTool(ref)).toBeUndefined();
  expect(registry.findBySubmitTool("lab/pi_run")?.id).toBe("lab-worker");
});

test("the registry is immutable and does not alias caller input", () => {
  const executors = [
    {
      id: "lab-a",
      protocol: "pi-durable-v1" as const,
      submitTool: "lab-a/pi_run",
      statusTool: "lab-a/pi_status",
    },
  ];
  const input = { version: 1 as const, executors };
  const registry = createDurableExecutorRegistry(input);
  executors[0]!.id = "mutated";
  executors[0]!.submitTool = "lab/mutated";
  executors.push({
    id: "lab-b",
    protocol: "pi-durable-v1",
    submitTool: "lab-b/pi_run",
    statusTool: "lab-b/pi_status",
  });
  expect(registry.findById("lab-a")?.submitTool).toBe("lab-a/pi_run");
  expect(registry.findById("mutated")).toBeUndefined();
  expect(registry.findBySubmitTool("lab/mutated")).toBeUndefined();
  expect(registry.findById("lab-b")).toBeUndefined();
  const found = registry.findById("lab-a")!;
  expect(() => {
    (found as { id: string }).id = "nope";
  }).toThrow();
  expect(registry.findById("lab-a")?.id).toBe("lab-a");
});

test("strict config rejects extra fields, duplicates, and oversized lists", () => {
  const cases: unknown[] = [
    { version: 2, executors: valid.executors },
    { version: 1, executors: valid.executors, extra: true },
    { version: 1, executors: [{ ...valid.executors[0], extra: true }] },
    {
      version: 1,
      executors: [{ ...valid.executors[0], protocol: "hermes-v0" }],
    },
    { version: 1, executors: [{ ...valid.executors[0], id: "Pi-M4" }] },
    { version: 1, executors: [{ ...valid.executors[0], id: "lab_worker" }] },
    { version: 1, executors: [{ ...valid.executors[0], id: "-lab" }] },
    { version: 1, executors: [{ ...valid.executors[0], id: "lab-" }] },
    { version: 1, executors: [{ ...valid.executors[0], id: "lab--worker" }] },
    { version: 1, executors: [{ ...valid.executors[0], id: "a".repeat(65) }] },
    { version: 1, executors: [{ ...valid.executors[0], submitTool: "lab" }] },
    {
      version: 1,
      executors: [{ ...valid.executors[0], submitTool: "lab/submit/extra" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], statusTool: "lab/job status" }],
    },
    {
      version: 1,
      executors: [
        {
          ...valid.executors[0],
          submitTool: "lab/pi_run",
          statusTool: "lab/pi_run",
        },
      ],
    },
    {
      version: 1,
      executors: [
        valid.executors[0],
        {
          ...valid.executors[0],
          submitTool: "lab-other/pi_run",
          statusTool: "lab-other/pi_status",
        },
      ],
    },
    {
      version: 1,
      executors: [
        valid.executors[0],
        {
          id: "other-worker",
          protocol: "pi-durable-v1",
          submitTool: "lab/pi_run",
          statusTool: "other/pi_status",
        },
      ],
    },
    {
      version: 1,
      executors: [
        valid.executors[0],
        {
          id: "other-worker",
          protocol: "pi-durable-v1",
          submitTool: "other/pi_run",
          statusTool: "lab/pi_status",
        },
      ],
    },
    {
      version: 1,
      executors: Array.from({ length: 33 }, (_, i) => ({
        id: `w-${i}`,
        protocol: "pi-durable-v1",
        submitTool: `v${i}/pi_run`,
        statusTool: `v${i}/pi_status`,
      })),
    },
  ];
  for (const input of cases) {
    expect(() => createDurableExecutorRegistry(input)).toThrow(
      DURABLE_EXECUTOR_CONFIG_ERROR,
    );
  }
});

test("unreadable, relative, and malformed files throw a sanitized config error", () => {
  const secret = "LEAKED_WORKER_TOKEN_9f3a";
  const relative = join("relative", "durable.json");
  const missing = join(dir, "missing.json");
  const malformed = write(
    "malformed.json",
    `{not-json ${secret} "lab/pi_run"}`,
  );
  const invalid = write(
    "invalid.json",
    JSON.stringify({
      version: 1,
      executors: [{ ...valid.executors[0], protocol: "nope" }],
    }),
  );
  for (const path of [
    relative,
    "./durable.json",
    missing,
    malformed,
    invalid,
  ]) {
    expect(() => loadDurableExecutors(path)).toThrow(
      DURABLE_EXECUTOR_CONFIG_ERROR,
    );
    try {
      loadDurableExecutors(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe(DURABLE_EXECUTOR_CONFIG_ERROR);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(path);
      expect(message).not.toContain("lab/pi_run");
      expect(message).not.toContain("nope");
    }
  }
});

test("resolveWatchExecutor accepts exact v1 and shipped legacy payloads only", () => {
  const custom = createDurableExecutorRegistry(valid);
  expect(
    resolveWatchExecutor(
      {
        worker: "lab-worker",
        protocolVersion: 1,
        submitTool: "lab/pi_run",
        statusTool: "lab/pi_status",
      },
      custom,
    )?.id,
  ).toBe("lab-worker");
  expect(resolveWatchExecutor({ worker: "pi-m4" })?.submitTool).toBe(
    "pi-m4/pi_run",
  );
  expect(resolveWatchExecutor({ worker: "pi-m5" })?.statusTool).toBe(
    "pi-m5/pi_status",
  );
  expect(
    resolveWatchExecutor({ worker: "lab-worker" }, custom),
  ).toBeUndefined();
  expect(
    resolveWatchExecutor(
      {
        worker: "lab-worker",
        protocolVersion: 1,
        submitTool: "lab/pi_run",
      },
      custom,
    ),
  ).toBeUndefined();
  const remapped = createDurableExecutorRegistry({
    version: 1,
    executors: [{ ...valid.executors[0]!, statusTool: "lab-other/pi_status" }],
  });
  expect(
    resolveWatchExecutor(
      {
        worker: "lab-worker",
        protocolVersion: 1,
        submitTool: "lab/pi_run",
        statusTool: "lab/pi_status",
      },
      remapped,
    ),
  ).toBeUndefined();
  expect(
    resolveWatchExecutor(
      { worker: "pi-m4" },
      createDurableExecutorRegistry({
        version: 1,
        executors: [
          {
            id: "pi-m4",
            protocol: "pi-durable-v1",
            submitTool: "pi-m4/pi_run",
            statusTool: "pi-m4-other/pi_status",
          },
        ],
      }),
    ),
  ).toBeUndefined();
});

test("strict config rejects arbitrary methods and cross-protocol tools", () => {
  const cases: unknown[] = [
    {
      version: 1,
      executors: [
        {
          ...valid.executors[0],
          submitTool: "lab/submit_job",
          statusTool: "lab/job_status",
        },
      ],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], statusTool: "lab/job_status" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], submitTool: "lab/submit_job" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], submitTool: "lab/PI_RUN" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], statusTool: "lab/PI_STATUS" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], submitTool: "lab/hermes_run" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], protocol: "hermes-v0" }],
    },
    {
      version: 1,
      executors: [{ ...valid.executors[0], protocol: "pi-durable-v2" }],
    },
  ];
  for (const input of cases) {
    expect(() => createDurableExecutorRegistry(input)).toThrow(
      DURABLE_EXECUTOR_CONFIG_ERROR,
    );
  }
});

test("unsupported protocolVersion does not resolve as legacy", () => {
  expect(
    resolveWatchExecutor({
      worker: "pi-m4",
      protocolVersion: 2 as unknown as 1,
      submitTool: "pi-m4/pi_run",
      statusTool: "pi-m4/pi_status",
    }),
  ).toBeUndefined();
  expect(
    resolveWatchExecutor({
      worker: "pi-m5",
      protocolVersion: "pi-durable-v1" as unknown as 1,
      submitTool: "pi-m5/pi_run",
      statusTool: "pi-m5/pi_status",
    }),
  ).toBeUndefined();
});
