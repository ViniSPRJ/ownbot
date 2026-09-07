import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type JobState = "queued" | "running" | "completed" | "failed" | "interrupted";
export type Job<R> = {
  jobId: string; state: JobState; createdAt: string; updatedAt: string;
  result?: R; error?: string;
};
type Stored<R> = Job<R> & { fingerprint: string };
const terminal = (state: JobState) => !["queued", "running"].includes(state);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** One worker process owns this directory. Receipts are durable; interrupted work is never replayed. */
export class DurableJobs<A, R extends { ok: boolean }> {
  private records = new Map<string, Stored<R>>();
  private pending = new Set<Promise<void>>();
  constructor(private options: {
    directory: string;
    execute: (args: A, jobId: string, started: () => void) => Promise<R>;
    maxPending?: number; maxRecords?: number; retentionMs?: number; maxResultBytes?: number;
    now?: () => number;
  }) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    chmodSync(options.directory, 0o700);
    for (const name of readdirSync(options.directory)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const path = join(options.directory, name);
      try {
        if (statSync(path).size > (options.maxResultBytes ?? 2_000_000) + 4096) continue;
        const record = JSON.parse(readFileSync(path, "utf8")) as Stored<R>;
        if (record.jobId !== name.slice(0, -5) || !["queued", "running", "completed", "failed", "interrupted"].includes(record.state) || typeof record.fingerprint !== "string") continue;
        chmodSync(path, 0o600);
        this.records.set(record.jobId, record);
        if (!terminal(record.state)) this.persist({ ...record, state: "interrupted", error: "O processo do worker foi reiniciado antes de registrar a conclusão. Revise os artefatos antes de enviar uma nova tarefa.", updatedAt: this.time() });
      } catch { /* An unreadable record is never accepted as a completed job or overwritten. */ }
    }
    this.prune();
  }
  private time() { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  private path(id: string) { return join(this.options.directory, `${id}.json`); }
  private public(record: Stored<R>): Job<R> { const { fingerprint, ...job } = record; return structuredClone(job); }
  private persist(record: Stored<R>) {
    const temporary = `${this.path(record.jobId)}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path(record.jobId));
      const directoryFd = openSync(this.options.directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      this.records.set(record.jobId, record);
    } finally { rmSync(temporary, { force: true }); }
  }
  get(jobId: string): Job<R> | undefined {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return;
    const record = this.records.get(jobId); return record ? this.public(record) : undefined;
  }
  submit(args: A, idempotencyKey: string): Job<R> {
    if (!idempotencyKey || idempotencyKey.length > 256 || /[\0\r\n]/.test(idempotencyKey)) throw new Error("Use uma chave de idempotência válida, com até 256 caracteres.");
    const jobId = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
    const fingerprint = createHash("sha256").update(canonical(args)).digest("hex");
    const existing = this.records.get(jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Esta chave de idempotência já foi usada com outra tarefa.");
      return this.public(existing);
    }
    if (existsSync(this.path(jobId))) throw new Error("O recibo desta tarefa não pôde ser lido; revise-o antes de tentar novamente.");
    this.prune();
    if ([...this.records.values()].filter((r) => !terminal(r.state)).length >= (this.options.maxPending ?? 64)) throw new Error("A fila do worker está cheia.");
    if (this.records.size >= (this.options.maxRecords ?? 1000)) throw new Error("O armazenamento de recibos está cheio. Aguarde a retenção ou arquive os resultados.");
    const record: Stored<R> = { jobId, state: "queued", createdAt: this.time(), updatedAt: this.time(), fingerprint };
    this.persist(record);
    // Execute after the receipt has been persisted. The worker's existing semaphore is authoritative.
    const task = Promise.resolve().then(async () => {
      try {
        const result = await this.options.execute(args, jobId, () => this.persist({ ...record, state: "running", updatedAt: this.time() }));
        if (Buffer.byteLength(JSON.stringify(result)) > (this.options.maxResultBytes ?? 2_000_000)) {
          this.persist({ ...record, state: "failed", updatedAt: this.time(), error: "O resultado ultrapassou o limite do recibo. Revise os artefatos locais do worker." });
        } else this.persist({ ...record, state: result.ok ? "completed" : "failed", updatedAt: this.time(), result });
      } catch {
        this.persist({ ...record, state: "failed", updatedAt: this.time(), error: "A execução do worker falhou. Consulte os artefatos locais desta tarefa." });
      }
    });
    this.pending.add(task);
    // A persistence failure leaves the last durable state for restart recovery, never a success.
    void task.catch(() => {}).finally(() => this.pending.delete(task));
    return this.public(record);
  }
  prune() {
    const cutoff = (this.options.now ?? Date.now)() - (this.options.retentionMs ?? 7 * 86400_000);
    for (const record of this.records.values()) if (terminal(record.state) && Date.parse(record.updatedAt) < cutoff) {
      rmSync(this.path(record.jobId), { force: true }); this.records.delete(record.jobId);
    }
  }
  async settled() { await Promise.allSettled([...this.pending]); }
}
