import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntimeAgents } from "../src/copilot";
import { handoffTool } from "../src/agents/handoff-tool";
import type { HandoffDesk } from "../src/agents/handoff";

// The same build-only-one-bot path used by unattended routines, driven by a real ACP subprocess.
test("routine ACP coordinator delegates through owner-bound handoff tool without model API", async () => {
 const root = await mkdtemp(join(tmpdir(), "ownbot-routine-acp-"));
 const before = process.env.OPENBOT_ACP_CONFIG;
 const configFile = join(root,"config.json");
 const sent: unknown[] = [];
 const observed: unknown[] = [];
 const script = `import {createInterface} from 'node:readline';
 const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');let descriptor;
 createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);const reply=result=>emit({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}}});
 if(m.method==='session/new'){descriptor=m.params.mcpServers[0];return reply({sessionId:'routine-session'});}
 if(m.method==='session/prompt'){
 const headers=Object.fromEntries(descriptor.headers.map(h=>[h.name,h.value]));headers['Content-Type']='application/json';
 const r=await fetch(descriptor.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'message_bot',arguments:{bot:'codeexec',task:'Inspect the workspace'}}})});
 const result=await r.json();
 emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'routine-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:result.result.content[0].text}}}});
 return reply({stopReason:'end_turn'});
 }});`;
 try {
  await writeFile(configFile,JSON.stringify({profiles:{local:{command:process.execPath,args:["-e",script],workspaceRoot:root,timeoutMs:2000}},agents:{coord:"local"}}));
  process.env.OPENBOT_ACP_CONFIG=configFile;
  const agents=await resolveRuntimeAgents(
   async()=>[{id:"coord",name:"Coord",type:"built_in",systemPrompt:"Coordinate the desk",acpOwnerId:"routine-owner"}],
   {provider:"openai",defaultModel:"unused"},async()=>{throw Error("Must not resolve cloud API");},
   undefined,async()=>[],undefined,undefined,undefined,undefined,undefined,
   async(botId,input)=>[handoffTool({
    desk:{send:async value=>{sent.push(value);return {ok:true,toName:"Code",jobId:"job-1"};}} as unknown as HandoffDesk,
    from:{botId,actorId:"routine-owner",runId:input.runId,threadId:input.threadId,depth:0},
    hasSomebodyToAsk:true,maxDepth:3,maxPerRun:3,
   })!],"coord",
   async (botId, input, tools) => { observed.push({botId,runId:input.runId,threadId:input.threadId}); return tools.map(tool => ({...tool, execute: async args => { const result = await tool.execute(args); observed.push({ref:tool.ref,result}); return result; }})); },
  );
  const agent=agents.coord!;
  await new Promise<void>((resolve,reject)=>agent.run({threadId:"routine-thread",runId:"routine-run",messages:[{id:"firing",role:"user",content:"Routine firing: ask codeexec to inspect workspace"}],state:{},context:[],tools:[],forwardedProps:{}}).subscribe({error:reject,complete:resolve}));
  expect(observed[0]).toEqual({botId:"coord",runId:"routine-run",threadId:"routine-thread"});
  expect(observed).toHaveLength(2);
  expect(sent).toEqual([{from:{botId:"coord",actorId:"routine-owner",runId:"routine-run",threadId:"routine-thread",depth:0},target:"codeexec",envelope:{task:"Inspect the workspace"}}]);
 } finally {
  if(before===undefined)delete process.env.OPENBOT_ACP_CONFIG;else process.env.OPENBOT_ACP_CONFIG=before;
  await rm(root,{recursive:true,force:true});
 }
});
