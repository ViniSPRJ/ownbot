import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AcpAgent, type AcpSessionNotice } from "../src/acp/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/client";

const fixture = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const log=v=>appendFileSync(process.env.TEST_LOG,JSON.stringify(v)+'\\n');
let pending; let permissionCount=0;
const chunk=(sessionId,text)=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line); const ok=result=>emit({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize') {log({method:m.method,clientCapabilities:m.params.clientCapabilities,cloudKeyPresent:!!process.env.OPENAI_API_KEY});return ok({protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:process.env.TEST_MODE!=='nohttp'}}});}
 if(m.method==='session/new'||m.method==='session/load') {
  log({method:m.method,cwd:m.params.cwd,sessionId:m.params.sessionId});
  const descriptor=m.params.mcpServers[0];
  const headers=Object.fromEntries(descriptor.headers.map(h=>[h.name,h.value]));headers['Content-Type']='application/json';
  const r=await fetch(descriptor.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  log({bridgeType:descriptor.type,bridgeHost:new URL(descriptor.url).hostname,tools:(await r.json()).result.tools.map(t=>t.name)});
  if(m.method==='session/load')chunk(m.params.sessionId,'REPLAY MUST BE IGNORED');
  const extra=process.env.TEST_SESSION_RESULT?JSON.parse(process.env.TEST_SESSION_RESULT):{};
  return ok({sessionId:m.params.sessionId||crypto.randomUUID(),...extra});
 }
 if(m.method==='session/set_model'){log({method:m.method,modelId:m.params.modelId});return ok({});}
 if(m.method==='session/set_config_option'){
  log({method:m.method,configId:m.params.configId,value:m.params.value});
  if(process.env.TEST_CONFIRM==='no')return ok({configOptions:[{id:m.params.configId,category:'model',type:'select',currentValue:'other',options:[{value:'other',name:'Other'},{value:m.params.value,name:m.params.value}]}]});
  return ok({configOptions:[{id:m.params.configId,category:'model',type:'select',currentValue:m.params.value,options:[{value:m.params.value,name:m.params.value}]}]});
 }
 if(m.method==='session/prompt') {
  log({method:m.method,sessionId:m.params.sessionId,text:m.params.prompt[0].text});
  pending=m;
  if(process.env.TEST_MODE==='hang')return;
  if(process.env.TEST_MODE==='notice'||process.env.TEST_MODE==='notice-only') {
   emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'session_info_update',_meta:{jetbrains:{air:{version:1,sessionFailure:{severity:'warning',category:'unknown',title:'vendor-secret transport warning',actions:[]}}}}}}});
   if(process.env.TEST_MODE==='notice')chunk(m.params.sessionId,'clean answer');
   return ok({stopReason:'end_turn'});
  }
  if(process.env.TEST_MODE==='segments'||process.env.TEST_MODE==='no-final') {
   const update=u=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:u}});
   chunk(m.params.sessionId,'I will search.');
   update({sessionUpdate:'tool_call',toolCallId:'tool1',status:'pending'});
   update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'in_progress'});
   if(process.env.TEST_MODE==='no-final')return ok({stopReason:'end_turn'});
   chunk(m.params.sessionId,'I found the first source.');
   update({sessionUpdate:'tool_call_update',toolCallId:'tool2',status:'in_progress'});
   chunk(m.params.sessionId,'Final report: ');
   update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'completed'});
   update({sessionUpdate:'tool_call_update',toolCallId:'late-tool',status:'completed'});
   chunk(m.params.sessionId,'two verified findings.');
   return ok({stopReason:'end_turn'});
  }
  if(process.env.TEST_MODE==='permission-matrix') {
   const cases=[
    {name:'valid'}, {name:'reuse',reuse:true}, {name:'replay-event',replay:true}, {name:'no-correlation',skip:true},
    {name:'native-call',callMeta:false}, {name:'native-permission',permissionMeta:false},
    {name:'other-server',server:'external'}, {name:'ungranted',tool:'shell'},
    {name:'other-call-session',callSession:'other'}, {name:'other-request-session',requestSession:'other'},
    {name:'allow-always',kind:'allow_always'}, {name:'wrong-call-id',requestCall:'unknown'},
    {name:'generic-adapter',callMeta:false,permissionMeta:false}
   ];
   for(const c of cases){
    const callId=c.reuse||c.replay?'valid':c.name;
    if(!c.skip&&!c.reuse)emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:c.callSession||m.params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:callId,_meta:{is_mcp_tool_call:c.callMeta!==false},rawInput:{server:c.server||'ownbot',tool:c.tool||'approved_lookup'}}}});
    emit({jsonrpc:'2.0',id:'matrix-'+c.name,method:'session/request_permission',params:{sessionId:c.requestSession||m.params.sessionId,toolCall:{toolCallId:c.requestCall||callId},_meta:{is_mcp_tool_approval:c.permissionMeta!==false},options:[{optionId:'option-'+c.name,kind:c.kind||'allow_once',name:'Allow'}]}});
   }
   return;
  }
  if(process.env.TEST_MODE==='stopped') {chunk(m.params.sessionId,'partial');return ok({stopReason:'max_tokens'});}
  if(process.env.TEST_MODE==='fail')return emit({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'vendor-secret'}});
  return emit({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:m.params.sessionId,options:[{optionId:'allow',kind:'allow_always',name:'Allow'}]}});
 }
 if(typeof m.id==='string'&&m.id.startsWith('matrix-')){
  log({permissionCase:m.id.slice(7),permission:m.result});permissionCount++;
  if(permissionCount===13){chunk(pending.params.sessionId,'permissions complete');emit({jsonrpc:'2.0',id:pending.id,result:{stopReason:'end_turn'}});}
  return;
 }
 if(m.id==='permission'){
  log({permission:m.result});
  chunk('wrong-session','WRONG SESSION');
  chunk(pending.params.sessionId,'Hello ');chunk(pending.params.sessionId,'world');
  emit({jsonrpc:'2.0',id:pending.id,result:{stopReason:'end_turn'}});
 }
 if(m.method==='session/cancel')log({cancel:true});
});`;
function input(threadId: string, ids = ["u1"]): RunAgentInput {
 return { threadId, runId: crypto.randomUUID(), state: {}, tools: [], context: [], forwardedProps: {}, messages: ids.map(id=>({id,role:"user",content:`message-${id}`})) };
}
function collect(agent: AcpAgent, request: RunAgentInput): Promise<BaseEvent[]> {
 return new Promise((resolve,reject)=>{const events:BaseEvent[]=[];agent.run(request).subscribe({next:e=>events.push(e),error:reject,complete:()=>resolve(events)});});
}
type HarnessOptions = {
 mode?: string;
 model?: string;
 resolveModel?: (threadId: string) => Promise<string | null>;
 sessionResult?: Record<string, unknown>;
 confirm?: "yes" | "no";
};
type MakeOptions = {
 resolveModel?: (threadId: string) => Promise<string | null>;
 onSession?: (notice: AcpSessionNotice) => void;
 tools?: (input: RunAgentInput) => Promise<readonly {name:string;ref:string;description:string;parameters:z.ZodType;execute:(args:unknown)=>Promise<string>}[]>;
};
async function harness(modeOrOptions: string | HarnessOptions = "normal") {
 const options: HarnessOptions = typeof modeOrOptions === "string" ? { mode: modeOrOptions } : modeOrOptions;
 const mode = options.mode ?? "normal";
 const root=await mkdtemp(join(tmpdir(),"ownbot-acp-agent-")); const log=join(root,"events.jsonl");
 const granted=async()=>[{name:"approved_lookup",ref:"test/lookup",description:"Lookup",parameters:z.object({}),execute:async()=>"ok" as const}];
 const env: NodeJS.ProcessEnv = {TEST_LOG:log,TEST_MODE:mode};
 if (options.sessionResult) env.TEST_SESSION_RESULT = JSON.stringify(options.sessionResult);
 if (options.confirm) env.TEST_CONFIRM = options.confirm;
 const make=(ownerId="owner",agentId="research",extra: MakeOptions = {})=>new AcpAgent({ownerId,agentId,name:agentId,prompt:"standing instructions",profile:{profileId:"fake",command:process.execPath,args:["-e",fixture],env,workspaceRoot:root,timeoutMs:1500,...(options.model?{model:options.model}:{})},tools:extra.tools??granted,...(extra.resolveModel!==undefined?{resolveModel:extra.resolveModel}:options.resolveModel!==undefined?{resolveModel:options.resolveModel}:{}),...(extra.onSession?{onSession:extra.onSession}:{})});
 return {make,log,read:async()=> (await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line)),close:()=>rm(root,{recursive:true,force:true})};
}

describe("ACP agent subprocess integration",()=>{
 test("streams current session text, rejects native permissions and provides only granted MCP tools",async()=>{
  const h=await harness(); const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="test-cloud-secret";
  try {
   const events=await collect(h.make(),input("thread"));
   expect(events.map(e=>e.type)).toEqual(["RUN_STARTED","TEXT_MESSAGE_START","TEXT_MESSAGE_CONTENT","TEXT_MESSAGE_CONTENT","TEXT_MESSAGE_END","CUSTOM","RUN_FINISHED"]);
   expect(events.filter(e=>e.type==="TEXT_MESSAGE_CONTENT").map(e=>(e as any).delta).join("")).toBe("Hello world");
   const records=await h.read();expect(records.find(r=>r.permission).permission).toEqual({outcome:{outcome:"cancelled"}});
   expect(records.find(r=>r.bridgeType)).toEqual({bridgeType:"http",bridgeHost:"127.0.0.1",tools:["approved_lookup"]});
   expect(records.find(r=>r.method==="initialize").cloudKeyPresent).toBe(false);
  }finally {if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;await h.close();}
 });
 test("MCP allow-once requires current-session granted correlation and rejects native or replayed permissions",async()=>{
  const h=await harness("permission-matrix");try{
   await collect(h.make(),input("thread"));
   const results=(await h.read()).filter(r=>r.permissionCase);
   expect(results).toHaveLength(13);
   for(const result of results){
    expect(result.permission).toEqual(result.permissionCase==="valid"
     ?{outcome:{outcome:"selected",optionId:"option-valid"}}
     :{outcome:{outcome:"cancelled"}});
   }
  }finally{await h.close();}
 });
 test("resumes same owner/bot/thread with only new messages and isolates other owners and bots",async()=>{
  const h=await harness();try{
   await collect(h.make(),input("thread"));await Bun.sleep(20);
   const resumed=await collect(h.make(),input("thread",["u1","u2"]));await Bun.sleep(20);
   await collect(h.make("other-owner"),input("thread"));await Bun.sleep(20);
   await collect(h.make("owner","coord"),input("thread"));
   const records=await h.read(); const sessions=records.filter(r=>r.method==="session/new"||r.method==="session/load");
   expect(sessions.map(r=>r.method)).toEqual(["session/new","session/load","session/new","session/new"]);
   expect(sessions[0].cwd).toBe(sessions[1].cwd);expect(new Set(sessions.map(r=>r.cwd)).size).toBe(3);
   const prompts=records.filter(r=>r.method==="session/prompt");expect(prompts[1].text).toContain("message-u2");expect(prompts[1].text).not.toContain("message-u1");
   expect(JSON.stringify(resumed)).not.toContain("REPLAY MUST BE IGNORED");
  }finally{await h.close();}
 });
 test("missing history cursor starts a new session instead of replaying into old context",async()=>{
  const h=await harness();try{
   await collect(h.make(),input("thread"));await Bun.sleep(20);
   await collect(h.make(),input("thread",["different-history"]));
   const records=await h.read();expect(records.filter(r=>r.method==="session/load")).toHaveLength(0);
   expect(records.filter(r=>r.method==="session/new")).toHaveLength(2);
  }finally{await h.close();}
 });
 for(const mode of ["fail","nohttp","stopped","no-final","notice-only"])test(`fails closed without API fallback: ${mode}`,async()=>{
  const h=await harness(mode);try{
   await expect(collect(h.make(),input("thread"))).rejects.toThrow("não houve fallback para API");
   const records=await h.read();expect(records.filter(r=>r.method==="initialize")).toHaveLength(1);
   if(mode==="nohttp")expect(records.some(r=>r.method==="session/prompt")).toBe(false);
   if(mode==="stopped"){const cwd=records.find(r=>r.method==="session/new").cwd;expect(await Bun.file(join(cwd,".ownbot-session.json")).exists()).toBe(false);}
  }finally{await h.close();}
 });
 test("abortRun terminates observable with cancellation and no successful state",async()=>{
  const h=await harness("hang");try{
   const agent=h.make();let failure:Error|undefined;const events:BaseEvent[]=[];
   const sub=agent.run(input("thread")).subscribe({next:e=>events.push(e),error:e=>{failure=e;}});
   for(let i=0;i<100&&!events.length;i++)await Bun.sleep(10);
   agent.abortRun();await Bun.sleep(40);
   expect(failure?.message).toContain("cancelada");expect(sub.closed).toBe(true);
   expect(events.some(e=>e.type==="RUN_FINISHED")).toBe(false);
   const records=await h.read();const cwd=records.find(r=>r.method==="session/new").cwd;
   expect(await Bun.file(join(cwd,".ownbot-session.json")).exists()).toBe(false);
  }finally{await h.close();}
 });
 test("unsubscribe cancels without persisting partial session or emitting later output",async()=>{
  const h=await harness("hang");try{
   const agent=h.make();const events:BaseEvent[]=[];const sub=agent.run(input("thread")).subscribe({next:e=>events.push(e),error:()=>{}});
   for(let i=0;i<100&&!events.length;i++)await Bun.sleep(10);
   expect(events[0]?.type).toBe("RUN_STARTED");sub.unsubscribe();await Bun.sleep(40);
   expect(events.map(e=>e.type)).toEqual(["RUN_STARTED"]);
   const records=await h.read();const cwd=records.find(r=>r.method==="session/new").cwd;
   expect(await Bun.file(join(cwd,".ownbot-session.json")).exists()).toBe(false);
  }finally{await h.close();}
 });
});

test("Codex negotiates typed diagnostics without contaminating assistant text", async () => {
 const h=await harness("notice");
 try {
  const events=await collect(h.make(),input("thread"));
  expect((await h.read()).find(r=>r.method==="initialize").clientCapabilities).toEqual({_meta:{jetbrains:{air:{version:1,capabilities:["sessionFailure"]}}}});
  expect(events.filter(e=>e.type==="TEXT_MESSAGE_CONTENT").map(e=>(e as any).delta)).toEqual(["clean answer"]);
  expect(JSON.stringify(events)).not.toContain("vendor-secret");
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
 } finally {await h.close();}
});


test("ACP tool boundaries preserve separate messages, final marker and replay cursor", async () => {
 const h=await harness("segments");
 try {
  const first=await collect(h.make(),input("thread"));
  const starts=first.filter(e=>e.type==="TEXT_MESSAGE_START") as any[];
  const ends=first.filter(e=>e.type==="TEXT_MESSAGE_END") as any[];
  expect(starts).toHaveLength(3); expect(ends.map(e=>e.messageId)).toEqual(starts.map(e=>e.messageId));
  expect(new Set(starts.map(e=>e.messageId)).size).toBe(3);
  const messages=starts.map(e=>({id:e.messageId,role:"assistant" as const,content:first.filter(c=>c.type==="TEXT_MESSAGE_CONTENT"&&(c as any).messageId===e.messageId).map(c=>(c as any).delta).join("")}));
  expect(messages.map(m=>m.content)).toEqual(["I will search.","I found the first source.","Final report: two verified findings."]);
  expect(first.find(e=>e.type==="CUSTOM")).toMatchObject({name:"ownbot.acp.final-message",value:{messageId:messages[2]!.id}});
  const records=await h.read(); const cwd=records.find(r=>r.method==="session/new").cwd;
  const saved=JSON.parse(await readFile(join(cwd,".ownbot-session.json"),"utf8"));
  expect(saved.replyMessageId).toBe(messages[2]!.id); expect(saved.replyMessageIds).toEqual(messages.map(m=>m.id));
  const next=input("thread",["u1"]); next.messages.push(...messages,{id:"u2",role:"user",content:"Next user question"});
  await collect(h.make(),next);
  const prompt=(await h.read()).filter(r=>r.method==="session/prompt")[1].text;
  expect(prompt).toContain("Next user question");
  for(const message of messages) expect(prompt).not.toContain(message.content);
 } finally {await h.close();}
});

test("standard AG-UI consumer keeps every segment and exposes final ID to routine subscribers", async () => {
 const h=await harness("segments");
 try {
  const agent=h.make(); agent.threadId="consumer-thread"; agent.messages=input("consumer-thread").messages;
  const buffers: string[]=[]; let finalId: string|undefined;
  agent.subscribe({onTextMessageEndEvent: ({textMessageBuffer}) => {buffers.push(textMessageBuffer);},onCustomEvent: ({event}) => {if(event.name==="ownbot.acp.final-message")finalId=event.value.messageId;}});
  await agent.runAgent({runId:crypto.randomUUID()});
  expect(buffers).toEqual(["I will search.","I found the first source.","Final report: two verified findings."]);
  const messages=agent.messages.filter(m=>m.role==="assistant");
  expect(messages).toHaveLength(3); expect(messages.at(-1)?.id).toBe(finalId);
  expect(messages.at(-1)?.content).toBe("Final report: two verified findings.");
 }finally{await h.close();}
});

test("unexpected model resolver errors fail closed before CLI or tools and release the lock", async () => {
 const secret = "resolver-secret-db-url";
 const h = await harness();
 let toolsCalled = 0;
 const events: BaseEvent[] = [];
 const warnings: string[] = [];
 const warn = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(String(args[0])); });
 try {
  const agent = h.make("owner", "research", {
   resolveModel: async () => { throw new Error(`lookup failed: ${secret}`); },
   tools: async () => { toolsCalled++; return [{name:"approved_lookup",ref:"test/lookup",description:"Lookup",parameters:z.object({}),execute:async()=>"ok"}]; },
  });
  let failure: Error | undefined;
  await new Promise<void>((resolve) => {
   agent.run(input("thread")).subscribe({
    next: e => events.push(e),
    error: e => { failure = e; resolve(); },
    complete: resolve,
   });
  });
  expect(failure?.message).toBe("A execução ACP não foi concluída. Verifique autenticação, perfil e disponibilidade da CLI; não houve fallback para API.");
  expect(toolsCalled).toBe(0);
  expect(await Bun.file(h.log).exists()).toBe(false);
  expect(events.some(e => e.type === "RUN_FINISHED")).toBe(false);
  expect(JSON.stringify({events, warnings, public: failure?.message})).not.toContain(secret);
  const line = warnings.find(w => w.includes("acp-run-failed"));
  expect(line).toBeDefined();
  expect(JSON.parse(line!).phase).toBe("model_resolution");
  expect(line).not.toContain(secret);
  warn.mockRestore();
  const retry = await collect(h.make(), input("thread"));
  expect(retry.at(-1)?.type).toBe("RUN_FINISHED");
 } finally { warn.mockRestore(); await h.close(); }
});

test("absent resolver and explicit null keep the profile default; an explicit choice is sent to the CLI", async () => {
 const h = await harness({ model: "profile-default" });
 try {
  await collect(h.make(), input("absent"));
  await collect(h.make("owner", "research", { resolveModel: async () => null }), input("invalidated"));
  await collect(h.make("owner", "research", { resolveModel: async () => "conversation-model" }), input("chosen"));
  const selected = (await h.read()).filter(r => r.method === "session/set_model").map(r => r.modelId);
  expect(selected).toEqual(["profile-default", "profile-default", "conversation-model"]);
 } finally { await h.close(); }
});

const modernCatalogue = {
 configOptions: [
  {
   id: "engine",
   category: "model",
   type: "select",
   currentValue: "small",
   options: [
    { value: "small", name: "Small" },
    { value: "large", name: "Large" },
   ],
  },
 ],
};

test("with no requested model the session catalogue currentModel is the confirmation", async () => {
 const notices: AcpSessionNotice[] = [];
 const h = await harness({ sessionResult: modernCatalogue });
 try {
  const request = input("thread");
  await collect(h.make("owner", "research", { onSession: (notice) => notices.push(notice) }), request);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
   threadId: "thread",
   runId: request.runId,
   requestedModel: null,
   model: null,
   resolvedModel: "small",
   executor: "acp",
   profileId: "fake",
   provider: "codex",
  });
  expect((await h.read()).some((r) => r.method === "session/set_model" || r.method === "session/set_config_option")).toBe(false);
 } finally { await h.close(); }
});

test("an explicit config-option selection is confirmed only by the matching current value", async () => {
 const notices: AcpSessionNotice[] = [];
 const h = await harness({ sessionResult: modernCatalogue });
 try {
  await collect(
   h.make("owner", "research", {
    resolveModel: async () => "large",
    onSession: (notice) => notices.push(notice),
   }),
   input("thread"),
  );
  expect(notices).toEqual([
   expect.objectContaining({
    requestedModel: "large",
    model: "large",
    resolvedModel: "large",
    executor: "acp",
   }),
  ]);
  expect((await h.read()).filter((r) => r.method === "session/set_config_option").map((r) => r.value)).toEqual(["large"]);
 } finally { await h.close(); }
});

test("a legacy set_model empty ACK leaves the model unresolved and does not reuse the previous current value", async () => {
 const notices: AcpSessionNotice[] = [];
 const h = await harness({
  sessionResult: {
   models: {
    currentModelId: "small",
    availableModels: [
     { modelId: "small", name: "Small" },
     { modelId: "large", name: "Large" },
    ],
   },
  },
 });
 try {
  await collect(
   h.make("owner", "research", {
    resolveModel: async () => "large",
    onSession: (notice) => notices.push(notice),
   }),
   input("thread"),
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]?.requestedModel).toBe("large");
  expect(notices[0]?.model).toBe("large");
  expect(notices[0]?.resolvedModel).toBeNull();
  expect((await h.read()).filter((r) => r.method === "session/set_model").map((r) => r.modelId)).toEqual(["large"]);
 } finally { await h.close(); }
});

test("a model selection error never emits a successful session notice", async () => {
 const notices: AcpSessionNotice[] = [];
 const h = await harness({ sessionResult: modernCatalogue, confirm: "no" });
 try {
  await expect(
   collect(
    h.make("owner", "research", {
     resolveModel: async () => "large",
     onSession: (notice) => notices.push(notice),
    }),
    input("thread"),
   ),
  ).rejects.toThrow("não houve fallback para API");
  expect(notices).toEqual([]);
 } finally { await h.close(); }
});
