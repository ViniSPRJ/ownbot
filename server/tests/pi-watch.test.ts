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
  });
  test("registration failure preserves accepted jobId and explicitly warns, never throws or reruns", async () => {
    const f = fixture(); f.queue.offer = async () => { throw new Error("DB offline"); };
    const result = await f.watcher.observe(context, [f.tool()])[0]!.execute({ background: true });
    expect(result).toContain(id); expect(result).toContain("could not be persisted"); expect(f.counts().calls).toBe(1);
  });
  test("watch identity includes both owner and worker", () => {
    expect(new Set([piWatchKey("a", "pi-m4", id), piWatchKey("b", "pi-m4", id), piWatchKey("a", "pi-m5", id)]).size).toBe(3);
  });
});
