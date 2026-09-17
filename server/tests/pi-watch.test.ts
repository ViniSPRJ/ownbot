import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createPiWatcher, PI_WATCH_KIND, PI_WATCH_MAX_AGE_MS, piWatchKey } from "../src/agents/pi-watch";
import type { WorkQueue, WorkItem } from "../src/work/queue";
const id = "a".repeat(32);
const context = { actorId: "owner", botId: "code", runId: "run", threadId: "scratch", depth: 2, originRequest: { botId: "coord", threadId: "visible" } };
const job = (state = "running", extra = {}) => JSON.stringify({ jobId: id, state, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:01:00.000Z", ...extra });
function fixture() {
  let time = 100_000; let allowed = true; let status = job(); let calls = 0; let polls = 0;
  const offers: any[] = [], finishes: any[] = [], releases: any[] = [], rows = new Map<string, WorkItem>();
  const queue = {
    offer: async (item: any) => { offers.push(item); if (rows.has(item.key)) return "already"; rows.set(item.key, { ...item, attempts: 1 }); return "queued"; },
    claim: async () => [...rows.values()].filter((v: any) => !v.finished),
    finish: async (input: any) => { finishes.push(input); const row: any = rows.get(input.key); if (row.finished) return false; row.finished = true; return true; },
    release: async (input: any) => { releases.push(input); return true; }, purge: async () => 0,
  } as unknown as WorkQueue;
  const watcher = createPiWatcher({ queue, owner: "replica", now: () => time, authorised: async () => allowed,
    store: { callTool: async (input: any) => { polls++; expect(input).toEqual({ ref: "pi-m5/pi_status", args: { jobId: id }, botId: "code", actorId: "owner" }); return { text: status, isError: false }; } },
  });
  const tool = (ref = "pi-m5/pi_run", text = job()) => ({ name: "pi", description: "", ref, parameters: z.object({}), execute: async () => { calls++; return text; } });
  return { watcher, tool, offers, finishes, releases, rows, queue, setStatus: (v: string) => status = v, revoke: () => allowed = false,
    advance: () => time += PI_WATCH_MAX_AGE_MS, counts: () => ({ calls, polls }) };
}
function parsePiReceipt(task: string) {
  const start = task.indexOf("<pi_receipt>\n");
  const end = task.indexOf("\n</pi_receipt>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const json = task.slice(start + "<pi_receipt>\n".length, end);
  expect(json.length).toBeLessThanOrEqual(12_000);
  expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(12_000);
  return { json, data: JSON.parse(json) as Record<string, unknown> };
}
/** External validator for advertised format json-sorted-keys-v1. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
function digestEvidence(evidence: unknown) {
  return { format: "json-sorted-keys-v1", sha256: createHash("sha256").update(canonicalJson(evidence)).digest("hex") };
}
describe("durable Pi completion watcher", () => {
  test("only verified successful background submission is observed; context comes from server", async () => {
    const f = fixture();
    for (const [ref, args, result] of [
      ["other/pi_run", { background: true }, job()], ["pi-m5/pi_status", { background: true }, job()],
      ["pi-m5/pi_run", {}, job()], ["pi-m5/pi_run", { background: true }, "Refused. no grant"],
      ["pi-m5/pi_run", { background: true }, '{"jobId":"fake","state":"queued"}'],
    ] as const) await f.watcher.observe(context, [f.tool(ref, result)])[0]!.execute(args);
    expect(f.offers).toHaveLength(0);
    await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true, threadId: "victim", actorId: "other" });
    expect(f.offers[0].kind).toBe(PI_WATCH_KIND);
    expect(f.offers[0].payload.originRequest).toEqual({ botId: "coord", threadId: "visible" });
    expect(f.offers[0].payload.actorId).toBe("owner");
  });
  test("idempotent registration then running poll, completed receipt enqueues one trusted return", async () => {
    const f = fixture(); const wrapped = f.watcher.observe(context, [f.tool()])[0]!;
    await wrapped.execute({ background: true }); await wrapped.execute({ background: true });
    expect(f.rows.size).toBe(1); await f.watcher.sweep(); expect(f.releases).toHaveLength(1);
    f.setStatus(job("completed", { result: { ok: true, text: "answer" } })); await f.watcher.sweep(); await f.watcher.sweep();
    expect(f.finishes).toHaveLength(1);
    expect(f.finishes[0].result.state).toBe("completed");
    expect(f.finishes[0].followUp.payload).toMatchObject({ toBotId: "coord", actorId: "owner", answerIn: "visible", depth: 2 });
    expect(f.finishes[0].followUp.payload.task).toContain("untrusted worker output");
    expect(f.counts()).toEqual({ calls: 2, polls: 2 });
  });
  test.each(["failed", "interrupted"])("terminal %s wakes requester with failure and never reruns", async (state) => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    f.setStatus(job(state, { error: "worker stopped" })); await f.watcher.sweep();
    expect(f.finishes[0].result.state).toBe(state); expect(f.counts().calls).toBe(1);
  });
  test("completed without successful result is unknown; mismatched receipts are retried", async () => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    f.setStatus(job("completed", { jobId: "b".repeat(32), result: { ok: true } })); await f.watcher.sweep();
    expect(f.finishes).toHaveLength(0); expect(f.releases).toHaveLength(1);
    f.setStatus(job("completed", { result: { ok: false } })); await f.watcher.sweep(); expect(f.finishes[0].result.state).toBe("unknown");
  });
  test("revoked owner/grant never polls or wakes an inaccessible agent", async () => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    f.revoke(); await f.watcher.sweep(); expect(f.counts().polls).toBe(0);
    expect(f.finishes[0].result.state).toBe("access_revoked"); expect(f.finishes[0].followUp).toBeUndefined();
  });
  test("24 hour expiry returns honest unknown without cancelling or executing worker", async () => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    f.advance(); await f.watcher.sweep(); expect(f.finishes[0].result.state).toBe("unknown"); expect(f.counts().polls).toBe(0);
    expect(f.finishes[0].result.evidence).toContain("24-hour tracking window");
    expect(parsePiReceipt(f.finishes[0].followUp.payload.task).data.truncated).toBe(false);
  });
  test("registration failure preserves accepted jobId and explicitly warns, never throws or reruns", async () => {
    const f = fixture(); f.queue.offer = async () => { throw new Error("DB offline"); };
    const result = await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    expect(result).toContain(id); expect(result).toContain("could not be persisted"); expect(f.counts().calls).toBe(1);
  });
  test("watch identity includes both owner and worker", () => {
    expect(new Set([piWatchKey("a", "pi-m4", id), piWatchKey("b", "pi-m4", id), piWatchKey("a", "pi-m5", id)]).size).toBe(3);
  });
  test("small evidence is preserved unchanged in a valid non-truncated receipt", async () => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    f.setStatus(job("completed", { result: { ok: true, text: "answer" } })); await f.watcher.sweep();
    const { data } = parsePiReceipt(f.finishes[0].followUp.payload.task);
    expect(data.truncated).toBe(false);
    expect(data.evidence).toEqual(f.finishes[0].result.evidence);
    expect(data.evidence).toMatchObject({ jobId: id, state: "completed", result: { ok: true, text: "answer" } });
    expect(data.retrieve).toEqual({ tool: "pi-m5/pi_status", jobId: id });
    expect(data.queue).toEqual({ kind: PI_WATCH_KIND, key: piWatchKey("owner", "pi-m5", id) });
    expect(String(data.retention)).toContain("not promised forever");
    expect(f.finishes[0].result.evidenceChecksum).toEqual(digestEvidence(f.finishes[0].result.evidence));
    expect(data.evidenceChecksum).toEqual(f.finishes[0].result.evidenceChecksum);
    expect(f.finishes[0].followUp.payload.task).not.toContain("partial preview");
  });
  test("oversized Unicode-escaped evidence stays valid JSON, marks truncation, and persists the tail", async () => {
    const f = fixture(); await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    const marker = "TAIL_MARKER_7f3a";
    // Quotes, controls and line separators expand under JSON.stringify; emoji inflate UTF-8 bytes.
    const bulky = `${"😀".repeat(5_000)}${"\"\\\n\u0001\u2028".repeat(4_000)}${marker}`;
    f.setStatus(job("completed", { result: { ok: true, text: bulky } })); await f.watcher.sweep();
    const task = f.finishes[0].followUp.payload.task as string;
    const { json, data } = parsePiReceipt(task);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(data.truncated).toBe(true);
    expect(f.finishes[0].result.truncated).toBe(true);
    const preview = (data.evidence as { preview: string }).preview;
    expect(preview).toBeTypeOf("string");
    expect(preview).not.toContain(marker);
    expect(f.finishes[0].result.evidence.result.text.endsWith(marker)).toBe(true);
    expect(JSON.stringify(f.finishes[0].result)).toContain(marker);
    expect(f.finishes[0].result.evidenceChecksum).toEqual(digestEvidence(f.finishes[0].result.evidence));
    expect(data.evidenceChecksum).toEqual(f.finishes[0].result.evidenceChecksum);
    expect(data.retrieve).toEqual({ tool: "pi-m5/pi_status", jobId: id });
    expect(task).toContain("pi_status");
    expect(task).toContain("do not infer success from this partial preview");
    expect(task).toContain("If full evidence is unavailable");
    expect(task).not.toMatch(/queue\.(get|read|fetch)/i);
  });
  test("in-flight grant revocation still finishes access_revoked without a wake", async () => {
    let allowed = true; let time = 100_000;
    const finishes: any[] = []; const rows = new Map<string, WorkItem>();
    const queue = {
      offer: async (item: any) => { rows.set(item.key, { ...item, attempts: 1 }); return "queued"; },
      claim: async () => [...rows.values()].filter((v: any) => !v.finished),
      finish: async (input: any) => { finishes.push(input); (rows.get(input.key) as any).finished = true; return true; },
      release: async () => true, purge: async () => 0,
    } as unknown as WorkQueue;
    const watcher = createPiWatcher({
      queue, owner: "replica", now: () => time, authorised: async () => allowed,
      store: { callTool: async () => { allowed = false; return { text: job("completed", { result: { ok: true, text: "secret" } }), isError: false }; } },
    });
    await watcher.observe(context, [{ name: "pi", description: "", ref: "pi-m5/pi_run", parameters: z.object({}), execute: async () => job() }])[0]!.execute({ background: true });
    await watcher.sweep();
    expect(finishes).toHaveLength(1);
    expect(finishes[0].result).toEqual({ state: "access_revoked" });
    expect(finishes[0].followUp).toBeUndefined();
  });
  test("checksum ignores nested object key order and changes when array order changes", async () => {
    async function finishWith(result: Record<string, unknown>) {
      const f = fixture();
      await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
      f.setStatus(job("completed", { result }));
      await f.watcher.sweep();
      return f.finishes[0].result;
    }
    const sameA = await finishWith({ ok: true, meta: { b: 2, a: 1 }, items: ["x", "y"] });
    const sameB = await finishWith({ items: ["x", "y"], meta: { a: 1, b: 2 }, ok: true });
    const differentArray = await finishWith({ ok: true, meta: { b: 2, a: 1 }, items: ["y", "x"] });
    expect(Object.keys(sameA.evidence.result.meta)).toEqual(["b", "a"]);
    expect(Object.keys(sameB.evidence.result.meta)).toEqual(["a", "b"]);
    expect(sameA.evidenceChecksum).toEqual(digestEvidence(sameA.evidence));
    expect(sameA.evidenceChecksum).toEqual(sameB.evidenceChecksum);
    expect(sameA.evidenceChecksum.format).toBe("json-sorted-keys-v1");
    expect(sameA.evidenceChecksum.sha256).not.toBe(differentArray.evidenceChecksum.sha256);
    expect(sameA.evidenceChecksum.sha256).not.toBe(createHash("sha256").update(JSON.stringify(sameA.evidence)).digest("hex"));
  });
});
