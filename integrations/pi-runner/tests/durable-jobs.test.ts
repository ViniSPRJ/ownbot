import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJobs } from "../src/durable-jobs";
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "pi-durable-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 5));
function latch() { let resolve!: () => void; return { promise: new Promise<void>((r) => { resolve = r; }), release: () => resolve() }; }
test("receipt persists before execution, is private and excludes task input", async () => {
 const directory=dir(), gate=latch(); const q=new DurableJobs({directory,execute:async(args:{task:string},id,start)=>{start();await gate.promise;return{ok:true,marker:"done"}}});
 const j=q.submit({task:"private prompt"},"first");expect(j.state).toBe("queued");expect(readdirSync(directory)).toEqual([j.jobId+".json"]);
 const f=join(directory,j.jobId+".json");expect(readFileSync(f,"utf8")).not.toContain("private prompt");expect(statSync(f).mode&0o777).toBe(0o600);expect(statSync(directory).mode&0o777).toBe(0o700);
 await tick();expect(q.get(j.jobId)?.state).toBe("running");gate.release();await q.settled();expect(q.get(j.jobId)?.state).toBe("completed");
});
test("idempotent retries execute once and reject changed input",async()=>{
 let runs=0;const gate=latch();const q=new DurableJobs({directory:dir(),execute:async(a:{a:number;b:number},id,start)=>{runs++;start();await gate.promise;return{ok:true}}});
 const j=q.submit({a:1,b:2},"key");expect(q.submit({b:2,a:1},"key").jobId).toBe(j.jobId);expect(()=>q.submit({a:3,b:2},"key")).toThrow("outra tarefa");gate.release();await q.settled();expect(runs).toBe(1);expect(q.submit({a:1,b:2},"key").state).toBe("completed");expect(runs).toBe(1);
});
test("completed result and diff survive restart without rerunning",async()=>{
 const directory=dir();const q=new DurableJobs({directory,execute:async()=>({ok:true,diff:"+ marker",stagingPath:"~/pi-staging/id"})});const j=q.submit({},"result");await q.settled();
 const restarted=new DurableJobs<{}, {ok:boolean;diff:string;stagingPath:string}>({directory,execute:async()=>{throw Error("must not run")}});expect(restarted.get(j.jobId)?.result).toEqual({ok:true,diff:"+ marker",stagingPath:"~/pi-staging/id"});expect(restarted.submit({},"result").state).toBe("completed");
});
test("restart marks queued and running interrupted without replay or success",()=>{
 const directory=dir();for(const [i,state]of["queued","running"].entries()){const jobId=String(i).repeat(32);writeFileSync(join(directory,jobId+".json"),JSON.stringify({jobId,state,fingerprint:"abc",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))}
 const q=new DurableJobs({directory,execute:async()=>{throw Error("must not run")}});expect(q.get("0".repeat(32))?.state).toBe("interrupted");expect(q.get("1".repeat(32))?.state).toBe("interrupted");expect(q.get("0".repeat(32))?.result).toBeUndefined();
});
test("thrown failures are terminal and sanitized",async()=>{
 const q=new DurableJobs({directory:dir(),execute:async()=>{throw Error("TOKEN=secret")}});const j=q.submit({},"fail");await q.settled();expect(q.get(j.jobId)?.state).toBe("failed");expect(JSON.stringify(q.get(j.jobId))).not.toContain("secret");
});
test("timed out worker result retains partial diff and never becomes completed",async()=>{
 const q=new DurableJobs({directory:dir(),execute:async()=>({ok:false,timedOut:true,diff:"+ partial"})});const j=q.submit({},"timeout");await q.settled();expect(q.get(j.jobId)).toMatchObject({state:"failed",result:{timedOut:true,diff:"+ partial"}});
});
test("queue and retained receipt counts are bounded and old terminal jobs expire",async()=>{
 let now=Date.now();const gate=latch();const q=new DurableJobs({directory:dir(),maxPending:1,maxRecords:1,retentionMs:100,now:()=>now,execute:async()=>{await gate.promise;return{ok:true}}});
 const j=q.submit({},"one");expect(()=>q.submit({},"two")).toThrow("fila");gate.release();await q.settled();expect(()=>q.submit({},"two")).toThrow("armazenamento");now+=101;q.prune();expect(q.get(j.jobId)).toBeUndefined();q.submit({},"two");await q.settled();
});
test("oversized results fail explicitly",async()=>{
 const q=new DurableJobs({directory:dir(),maxResultBytes:100,execute:async()=>({ok:true,text:"a".repeat(1000)})});const j=q.submit({},"large");await q.settled();expect(q.get(j.jobId)?.state).toBe("failed");expect(q.get(j.jobId)?.error).toContain("limite");
});
test("path traversal and malformed idempotency keys rejected",()=>{
 const q=new DurableJobs({directory:dir(),execute:async()=>({ok:true})});expect(q.get("../token")).toBeUndefined();expect(()=>q.submit({},"")).toThrow();expect(()=>q.submit({},"x\ny")).toThrow();
});
test("corrupt receipt cannot be overwritten and executed again",async()=>{
 const directory=dir();const q=new DurableJobs({directory,execute:async()=>({ok:true})});const j=q.submit({},"corrupt");await q.settled();writeFileSync(join(directory,j.jobId+".json"),"broken");const restarted=new DurableJobs({directory,execute:async()=>({ok:true})});expect(()=>restarted.submit({},"corrupt")).toThrow("recibo");
});
