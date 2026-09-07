import { test, expect } from "bun:test";
import { mkdtemp, mkdir, cp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(!process.env.PI_RUNNER_ROOT)("real MCP preserves sync calls and provides durable background submit/status with shared concurrency", async () => {
 const root=await mkdtemp(join(tmpdir(),"pi-server-test-"));await mkdir(join(root,"src"));
 await cp(join(process.env.PI_RUNNER_ROOT!,"src/server.ts"),join(root,"src/server.ts"));
 if (!(await readFile(join(root,"src/server.ts"),"utf8")).includes('import { DurableJobs }')) {
 const patched=Bun.spawn(["patch",join(root,"src/server.ts"),resolve("server.patch")],{stdout:"ignore",stderr:"pipe"});if(await patched.exited)throw Error("Pi baseline differs from patch");
 }await cp(resolve("src/durable-jobs.ts"),join(root,"src/durable-jobs.ts"));
 await symlink(join(process.env.PI_RUNNER_ROOT!,"node_modules"),join(root,"node_modules"));
 const fake=join(root,"fake-pi");await writeFile(fake,`#!/bin/sh\nsleep 0.3\nprintf 'marker\\n' > marker.txt\nprintf '%s\\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"ARTIFACT_OK"}]}]}'\n`,{mode:0o700});
 const reserve=Bun.serve({port:0,fetch:()=>new Response("ok")});const port=reserve.port;reserve.stop(true);
 const token="test-token";await writeFile(join(root,"token"),token,{mode:0o600});
 const env={...process.env,PI_RUNNER_PORT:String(port),PI_RUNNER_HOST:"127.0.0.1",PI_RUNNER_LIMIT:"1",PI_RUNNER_WORK_ROOT:join(root,"work"),PI_RUNNER_PI_BIN:fake,PI_MODELS:"fixture",PI_DEFAULT_MODEL:"fixture",PI_PRUNE_ON_START:"0"};
 let child=Bun.spawn([process.execPath,"run",join(root,"src/server.ts")],{env,stdout:"ignore",stderr:"ignore"});
 const healthy=async()=>{for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return}catch{}await Bun.sleep(20)}throw Error("server not ready")};
 const call=async(name:string,args:Record<string,unknown>)=>{
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
  const text=await response.text();const line=text.split("\n").find(l=>l.startsWith("data: "));const body=JSON.parse(line?line.slice(6):text);if(body.error)throw Error(JSON.stringify(body.error));return body.result;
 };
 try{
  await healthy();const args={task:"write marker",model:"fixture",background:true,idempotencyKey:"one",tools:["write"]};
  const submitted=(await call("pi_run",args)).structuredContent;expect(submitted.state).toBe("queued");
  const retried=(await call("pi_run",args)).structuredContent;expect(retried.jobId).toBe(submitted.jobId);
  const synchronous=call("pi_run",{task:"legacy",model:"fixture",tools:["write"]});await Bun.sleep(30);
  const aggregate=(await call("pi_status",{})).structuredContent;expect(aggregate.backgroundJobs).toBe(true);expect(aggregate.busy).toBe(1);expect(aggregate.queued).toBe(1);
  const legacy=(await synchronous).structuredContent;expect(legacy.ok).toBe(true);expect(legacy.runId).toBeString();expect(legacy.jobId).toBeUndefined();
  const finished=(await call("pi_status",{jobId:submitted.jobId})).structuredContent;expect(finished.state).toBe("completed");expect(finished.result.runId).toBe(submitted.jobId);expect(finished.result.diff).toContain("marker");expect(finished.result.text).toBe("ARTIFACT_OK");
  child.kill();await child.exited;child=Bun.spawn([process.execPath,"run",join(root,"src/server.ts")],{env,stdout:"ignore",stderr:"ignore"});await healthy();
  expect((await call("pi_status",{jobId:submitted.jobId})).structuredContent.state).toBe("completed");
  expect((await call("pi_run",{...args,task:"different"})).isError).toBe(true);
  expect((await call("pi_run",{task:"no key",background:true})).isError).toBe(true);
  const pending=(await call("pi_run",{...args,idempotencyKey:"interrupted"})).structuredContent;
  child.kill();await child.exited;child=Bun.spawn([process.execPath,"run",join(root,"src/server.ts")],{env,stdout:"ignore",stderr:"ignore"});await healthy();
  expect((await call("pi_status",{jobId:pending.jobId})).structuredContent.state).toBe("interrupted");await Bun.sleep(350);
 }finally{child.kill();await child.exited;await rm(root,{recursive:true,force:true})}
},15000);
