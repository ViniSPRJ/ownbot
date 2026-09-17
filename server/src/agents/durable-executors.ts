import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Explicit names of tools that already implement the Pi durable submit/status
 * contract (`pi-durable-v1`). This registry is not a CLI runtime: it does not
 * launch Pi, Hermes, Codex, or any worker, and it does not adapt a tool that
 * merely looks similar. A future Hermes adapter must implement that durable
 * contract before this registry may admit it.
 */
export const DURABLE_EXECUTOR_PROTOCOL = "pi-durable-v1" as const;
export const DURABLE_EXECUTOR_CONFIG_ERROR =
  "Durable executor configuration is invalid.";

const EXECUTOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VENDOR = "[A-Za-z0-9_-]{1,64}";
const SUBMIT_TOOL = new RegExp(`^${VENDOR}/pi_run$`);
const STATUS_TOOL = new RegExp(`^${VENDOR}/pi_status$`);
const MAX_EXECUTORS = 32;

const executorIdSchema = z.string().min(1).max(64).regex(EXECUTOR_ID);
const executorSchema = z
  .object({
    id: executorIdSchema,
    protocol: z.literal(DURABLE_EXECUTOR_PROTOCOL),
    submitTool: z.string().regex(SUBMIT_TOOL),
    statusTool: z.string().regex(STATUS_TOOL),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    executors: z.array(executorSchema).max(MAX_EXECUTORS),
  })
  .strict();

export type DurableExecutor = {
  readonly id: string;
  readonly protocol: typeof DURABLE_EXECUTOR_PROTOCOL;
  readonly submitTool: string;
  readonly statusTool: string;
};

export type DurableExecutorConfig = {
  version: 1;
  executors: readonly DurableExecutor[];
};

export type WatchExecutorBinding = {
  worker: string;
  protocolVersion?: 1;
  submitTool?: string;
  statusTool?: string;
};

export type DurableExecutorRegistry = {
  findById(id: string): DurableExecutor | undefined;
  findBySubmitTool(ref: string): DurableExecutor | undefined;
};

const LEGACY_EXECUTORS: readonly DurableExecutor[] = Object.freeze([
  Object.freeze({
    id: "pi-m4",
    protocol: DURABLE_EXECUTOR_PROTOCOL,
    submitTool: "pi-m4/pi_run",
    statusTool: "pi-m4/pi_status",
  }),
  Object.freeze({
    id: "pi-m5",
    protocol: DURABLE_EXECUTOR_PROTOCOL,
    submitTool: "pi-m5/pi_run",
    statusTool: "pi-m5/pi_status",
  }),
]);

function invalidConfig(): never {
  throw new Error(DURABLE_EXECUTOR_CONFIG_ERROR);
}

function freezeExecutor(entry: DurableExecutor): DurableExecutor {
  return Object.freeze({
    id: entry.id,
    protocol: DURABLE_EXECUTOR_PROTOCOL,
    submitTool: entry.submitTool,
    statusTool: entry.statusTool,
  });
}

/**
 * Build an immutable registry from an explicit `{version:1,executors:[…]}`
 * document. Unknown fields, duplicate ids or tool refs, non-distinct
 * submit/status tools, and more than 32 entries are refused. `pi-durable-v1`
 * submit tools are `vendor/pi_run` and status tools `vendor/pi_status`; other
 * method names belong to a future protocol. Matching is exact: a vendor
 * prefix or a `pi_run` suffix is not a registration.
 */
export function createDurableExecutorRegistry(
  input: unknown,
): DurableExecutorRegistry {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) invalidConfig();
  const ids = new Set<string>();
  const refs = new Set<string>();
  const byId = new Map<string, DurableExecutor>();
  const bySubmit = new Map<string, DurableExecutor>();
  for (const entry of parsed.data.executors) {
    if (entry.submitTool === entry.statusTool) invalidConfig();
    if (
      ids.has(entry.id) ||
      refs.has(entry.submitTool) ||
      refs.has(entry.statusTool)
    ) {
      invalidConfig();
    }
    ids.add(entry.id);
    refs.add(entry.submitTool);
    refs.add(entry.statusTool);
    const frozen = freezeExecutor(entry);
    byId.set(frozen.id, frozen);
    bySubmit.set(frozen.submitTool, frozen);
  }
  return Object.freeze({
    findById(id: string) {
      const found = byId.get(id);
      return found ? freezeExecutor(found) : undefined;
    },
    findBySubmitTool(ref: string) {
      const found = bySubmit.get(ref);
      return found ? freezeExecutor(found) : undefined;
    },
  });
}

export const DEFAULT_DURABLE_EXECUTORS = createDurableExecutorRegistry({
  version: 1,
  executors: LEGACY_EXECUTORS,
});

/**
 * Synchronous startup read. An omitted path keeps the shipped default
 * logical mapping. A provided path replaces the entire registry; it must be
 * absolute. Callers typically pass `OPENBOT_DURABLE_EXECUTORS_CONFIG` at
 * process start; a changed file takes a restart. Unreadable, malformed, or
 * schema-invalid files throw a sanitized error that does not include the
 * path or file contents.
 */
export function loadDurableExecutors(
  configPath?: string,
): DurableExecutorRegistry {
  if (configPath == null || configPath === "") return DEFAULT_DURABLE_EXECUTORS;
  if (!isAbsolute(configPath)) invalidConfig();
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    invalidConfig();
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    invalidConfig();
  }
  return createDurableExecutorRegistry(json);
}

function completeBinding(work: WatchExecutorBinding): boolean {
  const count = [work.protocolVersion, work.submitTool, work.statusTool].filter(
    (field) => field !== undefined,
  ).length;
  return count === 0 || count === 3;
}

function matches(
  current: DurableExecutor,
  expected: Pick<
    DurableExecutor,
    "id" | "protocol" | "submitTool" | "statusTool"
  >,
): boolean {
  return (
    current.id === expected.id &&
    current.protocol === expected.protocol &&
    current.submitTool === expected.submitTool &&
    current.statusTool === expected.statusTool
  );
}

/**
 * Resolve a persisted watch record against the registry currently in memory.
 *
 * A v1 record is accepted only when id, protocol, submit tool and status tool
 * all match the live registration exactly. A legacy record (no new fields)
 * is accepted only for `pi-m4` / `pi-m5` when that id still maps to the
 * original Pi refs. An explicitly unsupported `protocolVersion` does not
 * resolve, even if the payload otherwise matches a shipped legacy job. A
 * custom id without the v1 fields, a partial v1 payload, or a
 * removed/remapped registration does not resolve.
 */
export function resolveWatchExecutor(
  work: WatchExecutorBinding,
  registry: DurableExecutorRegistry = DEFAULT_DURABLE_EXECUTORS,
): DurableExecutor | undefined {
  if (!completeBinding(work)) return undefined;
  const protocolVersion = (work as { protocolVersion?: unknown })
    .protocolVersion;
  if (protocolVersion !== undefined && protocolVersion !== 1) return undefined;
  const current = registry.findById(work.worker);
  if (!current) return undefined;
  if (protocolVersion === 1) {
    if (work.submitTool === undefined || work.statusTool === undefined)
      return undefined;
    return matches(current, {
      id: work.worker,
      protocol: DURABLE_EXECUTOR_PROTOCOL,
      submitTool: work.submitTool,
      statusTool: work.statusTool,
    })
      ? current
      : undefined;
  }
  const legacy = LEGACY_EXECUTORS.find((entry) => entry.id === work.worker);
  if (!legacy) return undefined;
  return matches(current, legacy) ? current : undefined;
}
