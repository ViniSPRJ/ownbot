/**
 * Operator archive of unknown handoffs. Not a replay, not a delivery, not a
 * forged original success.
 *
 * Dry-run is the default. `--apply` writes one all-or-nothing transaction:
 * `agent.handoff_reconciled` plus a `payload.result` wrapper that keeps the
 * original result. No queue offer, no relay, no message send.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import postgres from "postgres";

export const isExecutableMain = import.meta.main;

export const MANIFEST_VERSION = 1;
export const RESOLUTION = "internal_record_archived" as const;
export const ORIGINAL_OUTCOME = "unknown" as const;

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATH = 4096;
const MAX_ENTRIES = 8;
const MAX_WORK_KEY = 200;
const MAX_OPERATOR = 200;
const MAX_EVIDENCE_REFS = 16;
const MAX_EVIDENCE_REF = 500;
const MAX_RECEIPT_ID = 200;
const MAX_NOTE = 4000;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 32;
const MAX_JSON_ARRAY = 32;
const MAX_JSON_STRING = 4000;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const HANDOFF_KIND = "bot.message";
const EVENT_TYPE = "agent.handoff_reconciled";

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ManifestEntry = {
  workKey: string;
  expectedResult: { [key: string]: JsonValue };
  receiptPath: string;
  receiptSha256: string;
  resolution: typeof RESOLUTION;
  evidenceRefs: string[];
};

export type ReconcileManifest = {
  version: typeof MANIFEST_VERSION;
  operator: string;
  entries: ManifestEntry[];
};

export type Receipt = {
  workKey: string;
  originalResult: { [key: string]: JsonValue };
  resolution: typeof RESOLUTION;
  originalDeliveryOutcome: typeof ORIGINAL_OUTCOME;
  id?: string;
  note?: string;
};

export type ReconcileArgs = {
  manifestPath: string;
  apply: boolean;
};

export type EntryReport = {
  workKey: string;
  action: "would_reconcile" | "reconciled" | "already_reconciled";
  receiptSha256: string;
  receiptId: string;
  resolution: typeof RESOLUTION;
  fromBotId: string | null;
  toBotId: string | null;
  runId: string | null;
};

export type ReconcileReport = {
  mode: "dry-run" | "apply";
  operator: string;
  entries: EntryReport[];
};

type PreparedEntry = ManifestEntry & {
  receipt: Receipt;
  receiptId: string;
};

type Sql = postgres.Sql | postgres.TransactionSql;

function fail(message: string): never {
  throw new ReconcileError(message);
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`Missing value for ${flag}`);
  return value;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  let manifestPath: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = nextValue(argv, i, "--manifest");
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown argument ${arg}`);
    if (manifestPath) fail("Exactly one manifest path is required");
    manifestPath = arg;
  }
  if (!manifestPath) fail("Supply an absolute operator manifest path");
  assertAbsolutePath(manifestPath, "manifest path");
  return { manifestPath, apply };
}

export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (typeof left === "object") {
    if (typeof right !== "object" || Array.isArray(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonDeepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertBoundedString(
  value: unknown,
  label: string,
  max: number,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    fail(`${label} must be a string of 1..${max} characters`);
  if (hasControlChars(value))
    fail(`${label} must not contain control characters`);
  return value;
}

function assertAbsolutePath(value: string, label: string): string {
  assertBoundedString(value, label, MAX_PATH);
  if (!isAbsolute(value)) fail(`${label} must be an absolute path`);
  if (normalize(value) !== value)
    fail(`${label} must be a normalized absolute path`);
  return value;
}

function assertPlainJson(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) fail(`${path} exceeds JSON depth`);
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} is not a finite number`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING) fail(`${path} exceeds string bound`);
    if (value.includes("\0")) fail(`${path} must not contain NUL`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) fail(`${path} exceeds array bound`);
    return value.map((entry, index) =>
      assertPlainJson(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (!isPlainObject(value)) fail(`${path} is not plain JSON`);
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_KEYS) fail(`${path} exceeds object key bound`);
  const result: { [key: string]: JsonValue } = {};
  for (const key of keys) {
    if (key.length > 64) fail(`${path} has an oversized key`);
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      fail(`${path} has a forbidden key`);
    result[key] = assertPlainJson(value[key], `${path}.${key}`, depth + 1);
  }
  return result;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.has(key)) fail(`${label} has unexpected key ${key}`);
  }
  for (const key of required) {
    if (!keys.includes(key)) fail(`${label} is missing ${key}`);
  }
}

function sameHex(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase());
  const b = Buffer.from(right.toLowerCase());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function readOperatorFile(
  path: string,
  label: string,
): Promise<Buffer> {
  assertAbsolutePath(path, label);
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined)
    fail(`refusing to read ${label} without O_NOFOLLOW`);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ELOOP" || code === "EPERM")
      fail(`${label} must be a regular non-symlink file`);
    if (code === "ENOENT") fail(`${label} is not readable`);
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) fail(`${label} must be a regular non-symlink file`);
    if ((st.mode & 0o077) !== 0)
      fail(`${label} must be mode 0600 (group/other bits must be clear)`);
    if (st.size <= 0 || st.size > MAX_FILE_BYTES)
      fail(`${label} exceeds size bound`);
    const buf = await handle.readFile();
    if (buf.length > MAX_FILE_BYTES) fail(`${label} exceeds size bound`);
    return buf;
  } finally {
    await handle.close();
  }
}

function parseJsonObject(buf: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    fail(`${label} is not JSON`);
  }
  if (!isPlainObject(parsed)) fail(`${label} must be a JSON object`);
  return parsed;
}

function parseExpectedResult(
  value: unknown,
  label: string,
): { [key: string]: JsonValue } {
  const json = assertPlainJson(value, label);
  if (!json || typeof json !== "object" || Array.isArray(json))
    fail(`${label} must be a plain JSON object`);
  if (json.outcome !== ORIGINAL_OUTCOME)
    fail(`${label} must have outcome unknown`);
  return json;
}

function parseEvidenceRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array of strings`);
  if (value.length > MAX_EVIDENCE_REFS) fail(`${label} exceeds array bound`);
  return value.map((entry, index) =>
    assertBoundedString(entry, `${label}[${index}]`, MAX_EVIDENCE_REF),
  );
}

function parseManifestObject(raw: Record<string, unknown>): ReconcileManifest {
  assertExactKeys(raw, ["version", "operator", "entries"], [], "manifest");
  if (raw.version !== MANIFEST_VERSION)
    fail("manifest schema version must be 1");
  const operator = assertBoundedString(raw.operator, "operator", MAX_OPERATOR);
  if (!Array.isArray(raw.entries)) fail("manifest entries must be an array");
  if (raw.entries.length < 1 || raw.entries.length > MAX_ENTRIES)
    fail(`manifest entries must have 1..${MAX_ENTRIES} items`);
  const seen = new Set<string>();
  const entries = raw.entries.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`entries[${index}] must be an object`);
    assertExactKeys(
      entry,
      [
        "workKey",
        "expectedResult",
        "receiptPath",
        "receiptSha256",
        "resolution",
        "evidenceRefs",
      ],
      [],
      `entries[${index}]`,
    );
    const workKey = assertBoundedString(
      entry.workKey,
      `entries[${index}].workKey`,
      MAX_WORK_KEY,
    );
    if (seen.has(workKey)) fail(`duplicate workKey ${workKey}`);
    seen.add(workKey);
    const receiptSha256 = assertBoundedString(
      entry.receiptSha256,
      `entries[${index}].receiptSha256`,
      64,
    );
    if (!SHA256_HEX.test(receiptSha256))
      fail(`entries[${index}].receiptSha256 must be 64 hex characters`);
    if (entry.resolution !== RESOLUTION)
      fail(
        `entries[${index}].resolution must be ${RESOLUTION}; original requests were record-only`,
      );
    return {
      workKey,
      expectedResult: parseExpectedResult(
        entry.expectedResult,
        `entries[${index}].expectedResult`,
      ),
      receiptPath: assertAbsolutePath(
        String(entry.receiptPath ?? ""),
        `entries[${index}].receiptPath`,
      ),
      receiptSha256: receiptSha256.toLowerCase(),
      resolution: RESOLUTION,
      evidenceRefs: parseEvidenceRefs(
        entry.evidenceRefs,
        `entries[${index}].evidenceRefs`,
      ),
    };
  });
  return { version: MANIFEST_VERSION, operator, entries };
}

function parseReceiptObject(
  raw: Record<string, unknown>,
  label: string,
): Receipt {
  assertExactKeys(
    raw,
    ["workKey", "originalResult", "resolution", "originalDeliveryOutcome"],
    ["id", "note"],
    label,
  );
  const workKey = assertBoundedString(
    raw.workKey,
    `${label}.workKey`,
    MAX_WORK_KEY,
  );
  const originalResult = parseExpectedResult(
    raw.originalResult,
    `${label}.originalResult`,
  );
  if (raw.resolution !== RESOLUTION)
    fail(`${label}.resolution must be ${RESOLUTION}`);
  if (raw.originalDeliveryOutcome !== ORIGINAL_OUTCOME)
    fail(`${label}.originalDeliveryOutcome must be unknown`);
  const receipt: Receipt = {
    workKey,
    originalResult,
    resolution: RESOLUTION,
    originalDeliveryOutcome: ORIGINAL_OUTCOME,
  };
  if (raw.id !== undefined)
    receipt.id = assertBoundedString(raw.id, `${label}.id`, MAX_RECEIPT_ID);
  if (raw.note !== undefined)
    receipt.note = assertBoundedString(raw.note, `${label}.note`, MAX_NOTE);
  return receipt;
}

export async function loadPreparedManifest(
  manifestPath: string,
): Promise<{ manifest: ReconcileManifest; prepared: PreparedEntry[] }> {
  const bytes = await readOperatorFile(manifestPath, "manifest");
  const manifest = parseManifestObject(parseJsonObject(bytes, "manifest"));
  const prepared: PreparedEntry[] = [];
  for (const [index, entry] of manifest.entries.entries()) {
    const receiptBytes = await readOperatorFile(
      entry.receiptPath,
      `entries[${index}] receipt`,
    );
    const digest = createHash("sha256").update(receiptBytes).digest("hex");
    if (!sameHex(digest, entry.receiptSha256))
      fail(`entries[${index}] receipt hash does not match receiptSha256`);
    const receipt = parseReceiptObject(
      parseJsonObject(receiptBytes, `entries[${index}] receipt`),
      `entries[${index}] receipt`,
    );
    if (receipt.workKey !== entry.workKey)
      fail(`entries[${index}] receipt.workKey does not match workKey`);
    if (!jsonDeepEqual(receipt.originalResult, entry.expectedResult))
      fail(
        `entries[${index}] receipt.originalResult does not match expectedResult`,
      );
    prepared.push({
      ...entry,
      receipt,
      receiptId: receipt.id ?? entry.receiptSha256,
    });
  }
  return { manifest, prepared };
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function alreadyReconciled(
  result: Record<string, unknown>,
  entry: PreparedEntry,
): boolean {
  return (
    result.outcome === "reconciled" &&
    result.resolution === RESOLUTION &&
    result.originalOutcome === ORIGINAL_OUTCOME &&
    typeof result.receiptSha256 === "string" &&
    sameHex(result.receiptSha256, entry.receiptSha256) &&
    result.receiptPath === entry.receiptPath &&
    result.receiptId === entry.receiptId &&
    result.recipientDeliveryConfirmed === false &&
    jsonDeepEqual(result.previousResult, entry.expectedResult) &&
    jsonDeepEqual(result.evidenceRefs, entry.evidenceRefs)
  );
}

async function inspectEntry(
  sql: Sql,
  entry: PreparedEntry,
  apply: boolean,
): Promise<{
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  fromBotId: string | null;
  toBotId: string | null;
  runId: string | null;
  action: EntryReport["action"];
}> {
  const rows = apply
    ? await sql`
        SELECT payload,
          payload->>'fromBotId' AS from_bot_id,
          payload->>'toBotId' AS to_bot_id,
          payload->>'runId' AS run_id,
          finished_at IS NOT NULL AS finished,
          (claimed_by IS NOT NULL AND lease_until > now()) AS actively_leased
        FROM work_items
        WHERE kind = ${HANDOFF_KIND} AND key = ${entry.workKey}
        FOR UPDATE
      `
    : await sql`
        SELECT payload,
          payload->>'fromBotId' AS from_bot_id,
          payload->>'toBotId' AS to_bot_id,
          payload->>'runId' AS run_id,
          finished_at IS NOT NULL AS finished,
          (claimed_by IS NOT NULL AND lease_until > now()) AS actively_leased
        FROM work_items
        WHERE kind = ${HANDOFF_KIND} AND key = ${entry.workKey}
      `;
  const row = rows[0] as
    | {
        payload: unknown;
        from_bot_id: unknown;
        to_bot_id: unknown;
        run_id: unknown;
        finished: unknown;
        actively_leased: unknown;
      }
    | undefined;
  if (!row) fail(`work item ${entry.workKey} was not found`);
  if (!asBool(row.finished))
    fail(
      `work item ${entry.workKey} is not finished; this command does not replay or finish work`,
    );
  if (asBool(row.actively_leased))
    fail(`work item ${entry.workKey} is actively leased`);
  if (!isPlainObject(row.payload))
    fail(`work item ${entry.workKey} payload is not a JSON object`);
  if (!isPlainObject(row.payload.result))
    fail(`work item ${entry.workKey} result is not a JSON object`);
  const result = row.payload.result;
  const ids = {
    fromBotId: asId(row.from_bot_id),
    toBotId: asId(row.to_bot_id),
    runId: asId(row.run_id),
  };
  if (alreadyReconciled(result, entry)) {
    return {
      payload: row.payload,
      result,
      ...ids,
      action: "already_reconciled",
    };
  }
  if (result.outcome === "reconciled")
    fail(
      `work item ${entry.workKey} is already reconciled with a different archive`,
    );
  if (result.outcome !== ORIGINAL_OUTCOME)
    fail(`work item ${entry.workKey} current outcome is not unknown`);
  if (!jsonDeepEqual(result, entry.expectedResult))
    fail(
      `work item ${entry.workKey} current result does not match expectedResult`,
    );
  return {
    payload: row.payload,
    result,
    ...ids,
    action: apply ? "reconciled" : "would_reconcile",
  };
}

function reconciledResult(
  originalResult: Record<string, unknown>,
  entry: PreparedEntry,
  reconciledAt: string,
): Record<string, JsonValue> {
  return {
    outcome: "reconciled",
    originalOutcome: ORIGINAL_OUTCOME,
    previousResult: originalResult as { [key: string]: JsonValue },
    resolution: RESOLUTION,
    receiptId: entry.receiptId,
    receiptPath: entry.receiptPath,
    receiptSha256: entry.receiptSha256,
    evidenceRefs: entry.evidenceRefs,
    reconciledAt,
    recipientDeliveryConfirmed: false,
  };
}

function auditPayload(
  entry: PreparedEntry,
  ids: {
    fromBotId: string | null;
    toBotId: string | null;
    runId: string | null;
  },
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    originalOutcome: ORIGINAL_OUTCOME,
    resolution: RESOLUTION,
    receiptPath: entry.receiptPath,
    receiptSha256: entry.receiptSha256,
    evidenceRefs: entry.evidenceRefs,
    workKey: entry.workKey,
    receiptId: entry.receiptId,
    recipientDeliveryConfirmed: false,
  };
  if (ids.fromBotId) payload.from = ids.fromBotId;
  if (ids.toBotId) payload.to = ids.toBotId;
  if (ids.runId) payload.run = ids.runId;
  return payload;
}

async function applyEntry(
  sql: Sql,
  entry: PreparedEntry,
  inspected: Awaited<ReturnType<typeof inspectEntry>>,
  operator: string,
  reconciledAt: string,
): Promise<void> {
  const nextPayload = {
    ...inspected.payload,
    result: reconciledResult(inspected.result, entry, reconciledAt),
  };
  await sql`
    INSERT INTO audit_events (
      actor_user_id, event_type, target_type, target_id, payload
    ) VALUES (
      ${operator},
      ${EVENT_TYPE},
      ${"work_item"},
      ${entry.workKey},
      ${sql.json(auditPayload(entry, inspected))}
    )
  `;
  const updated = await sql`
    UPDATE work_items
    SET payload = ${sql.json(nextPayload)},
        claimed_by = NULL,
        lease_until = NULL,
        updated_at = now()
    WHERE kind = ${HANDOFF_KIND}
      AND key = ${entry.workKey}
      AND finished_at IS NOT NULL
    RETURNING key
  `;
  if (!updated[0])
    fail(`work item ${entry.workKey} could not be updated while finished`);
}

export async function reconcileHandoffs(options: {
  sql: postgres.Sql;
  manifest: ReconcileManifest;
  prepared: PreparedEntry[];
  apply: boolean;
}): Promise<ReconcileReport> {
  const run = async (sql: Sql): Promise<ReconcileReport> => {
    const reconciledAt = new Date().toISOString();
    const entries: EntryReport[] = [];
    for (const entry of options.prepared) {
      const inspected = await inspectEntry(sql, entry, options.apply);
      if (options.apply && inspected.action === "reconciled") {
        await applyEntry(
          sql,
          entry,
          inspected,
          options.manifest.operator,
          reconciledAt,
        );
      }
      entries.push({
        workKey: entry.workKey,
        action: inspected.action,
        receiptSha256: entry.receiptSha256,
        receiptId: entry.receiptId,
        resolution: RESOLUTION,
        fromBotId: inspected.fromBotId,
        toBotId: inspected.toBotId,
        runId: inspected.runId,
      });
    }
    return {
      mode: options.apply ? "apply" : "dry-run",
      operator: options.manifest.operator,
      entries,
    };
  };
  return options.apply
    ? options.sql.begin((tx) => run(tx))
    : options.sql.begin("READ ONLY", (tx) => run(tx));
}

export function connectReconcileDatabase(
  env: NodeJS.ProcessEnv = process.env,
): postgres.Sql {
  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    fail("DATABASE_URL is required; this command will not guess a database");
  }
  return postgres(databaseUrl, { max: 1, onnotice: () => {} });
}

export async function runReconcile(
  args: ReconcileArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileReport> {
  const { manifest, prepared } = await loadPreparedManifest(args.manifestPath);
  const sql = connectReconcileDatabase(env);
  try {
    return await reconcileHandoffs({
      sql,
      manifest,
      prepared,
      apply: args.apply,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(argv: string[]): Promise<void> {
  const report = await runReconcile(parseReconcileArgs(argv));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "reconcile-handoff failed"}\n`,
    );
    process.exit(1);
  }
}
