import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AcpAgent } from "../src/acp/agent";
import type { AcpProfile } from "../src/acp/config";
import { acpModelSelectionFor, saveAcpAgentModel } from "../src/acp/config";

/**
 * Two ownbot roles, one fake ACP CLI, two models.
 *
 * `acp-models.test.ts` proves the catalogue parser and the selection call against a stub transport,
 * and `acp-agent.test.ts` proves session resumption and isolation without models. What neither proves
 * is the part that can actually go wrong: that a per-role model travels through `agent.ts` into the
 * *session the CLI opened for that role*, that the CLI's own state then differs per session, and that
 * the model is still the role's own model after the subprocess died and the session was loaded again.
 *
 * So the fake CLI below keeps a real session table on disk (`TEST_STATE`), keyed by session id, and
 * answers `session/prompt` with the model it holds for that session — never with the model the test
 * asked for. A role that selected "large" but was routed into another role's session therefore answers
 * "small", and a selection that never reached the CLI leaves no row at all. Selections for a config
 * option the adapter does not advertise, a session it does not know, a workspace other than the one
 * that owns the session, or a model outside its catalogue are refused, so the assertions cannot be
 * satisfied by the client simply sending something that looked right.
 *
 * No hosted inference: the only process is `bun -e`, and the only network call is the loopback MCP
 * bridge the runtime itself started, read for `tools/list`.
 */
const MODELS = ["small", "large", "thinking"];
const CONFIG_ID = "engine";

const fixture = `
import {createInterface} from 'node:readline';
import {appendFileSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
const emit=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
const log=(v)=>appendFileSync(process.env.TEST_LOG,JSON.stringify(v)+'\\n');
const MODELS=${JSON.stringify(MODELS)};
const CONFIG_ID=${JSON.stringify(CONFIG_ID)};
const legacy=process.env.TEST_MODE==='legacy';
const options=MODELS.map((id)=>({value:id,name:id.charAt(0).toUpperCase()+id.slice(1)}));
const state=()=>{try{return JSON.parse(readFileSync(process.env.TEST_STATE,'utf8'));}catch{return {};};};
const save=(sessions)=>{const temporary=process.env.TEST_STATE+'.tmp';writeFileSync(temporary,JSON.stringify(sessions));renameSync(temporary,process.env.TEST_STATE);};
const configuration=(record)=>legacy
 ? {models:{availableModels:options.map((o)=>({modelId:o.value,name:o.name})),currentModelId:record.model}}
 : {configOptions:[{id:CONFIG_ID,category:'model',type:'select',currentValue:record.model,options},{id:'mode',category:'mode',type:'select',currentValue:'agent',options:[{value:'agent',name:'Agent'}]}]};
createInterface({input:process.stdin}).on('line',async(line)=>{
 const m=JSON.parse(line);
 const ok=(result)=>emit({jsonrpc:'2.0',id:m.id,result:result??null});
 const refuse=(code,message)=>emit({jsonrpc:'2.0',id:m.id,error:{code,message}});
 const sessions=state();
 // Every session-scoped call must name a session this adapter actually opened; a missing or
 // invented id is refused rather than silently honoured.
 if(['session/load','session/set_mode','session/set_config_option','session/set_model','session/prompt'].includes(m.method)){
  const record=sessions[m.params.sessionId];
  if(!record){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId??null,outcome:'unknown-session'});return refuse(-32002,'unknown session');}
 }
 if(m.method==='initialize'){log({method:m.method,pid:process.pid,mode:process.env.TEST_MODE});return ok({protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}}});}
 if(m.method==='session/new'){
  const sessionId='sess-'+crypto.randomUUID().slice(0,8);
  const descriptor=m.params.mcpServers[0];
  let tools=[];
  if(descriptor){const headers=Object.fromEntries(descriptor.headers.map((h)=>[h.name,h.value]));headers['Content-Type']='application/json';const response=await fetch(descriptor.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});const body=await response.json();tools=((body.result||{}).tools||[]).map((t)=>t.name);}
  const record={model:'small',cwd:m.params.cwd,pid:process.pid,loads:0,selections:0,prompts:0};
  sessions[sessionId]=record;save(sessions);
  log({method:m.method,pid:process.pid,sessionId,cwd:m.params.cwd,tools,currentModel:record.model});
  return ok({sessionId,...configuration(record)});
 }
 if(m.method==='session/load'){
  const record=sessions[m.params.sessionId];
  if(record.cwd!==m.params.cwd){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,restoredModel:record.model,outcome:'foreign-workspace'});return refuse(-32002,'session belongs to another workspace');}
  const restored=record.model;record.loads++;record.pid=process.pid;sessions[m.params.sessionId]=record;save(sessions);
  log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,cwd:m.params.cwd,restoredModel:restored,loads:record.loads,advertises:process.env.TEST_NO_CATALOGUE==='1'?false:true});
  if(process.env.TEST_NO_CATALOGUE==='1')return ok({sessionId:m.params.sessionId});
  return ok({sessionId:m.params.sessionId,...configuration(record)});
 }
 if(m.method==='session/set_mode'){
  const record=sessions[m.params.sessionId];
  if(m.params.modeId!=='agent'){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,outcome:'unknown-mode',modeId:m.params.modeId});return refuse(-32602,'unknown mode');}
  log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,modeId:m.params.modeId,model:record.model});
  return ok({currentModeId:'agent'});
 }
 if(m.method==='session/set_config_option'){
  if(legacy){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,outcome:'legacy-adapter'});return refuse(-32601,'legacy adapter advertises no config options');}
  const record=sessions[m.params.sessionId];
  if(m.params.configId!==CONFIG_ID){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,outcome:'unknown-config',configId:m.params.configId});return refuse(-32602,'unknown config option');}
  if(!MODELS.includes(m.params.value)){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,outcome:'unknown-model',value:m.params.value});return refuse(-32602,'model is not available');}
  const previous=record.model;record.model=m.params.value;record.selections++;record.pid=process.pid;sessions[m.params.sessionId]=record;save(sessions);
  log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,configId:m.params.configId,value:m.params.value,previous});
  return ok(configuration(record));
 }
 if(m.method==='session/set_model'){
  if(!legacy){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,outcome:'modern-adapter'});return refuse(-32601,'adapter advertises config options');}
  const record=sessions[m.params.sessionId];
  if(!MODELS.includes(m.params.modelId))return refuse(-32602,'model is not available');
  const previous=record.model;record.model=m.params.modelId;record.selections++;record.pid=process.pid;sessions[m.params.sessionId]=record;save(sessions);
  log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,value:m.params.modelId,previous});
  return ok({});
 }
 if(m.method==='session/prompt'){
  const record=sessions[m.params.sessionId];
  record.prompts++;sessions[m.params.sessionId]=record;save(sessions);
  log({method:m.method,pid:process.pid,sessionId:m.params.sessionId,effectiveModel:record.model,prompts:record.prompts,text:m.params.prompt[0].text});
  emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'model='+record.model+' session='+m.params.sessionId}}}});
  return ok({stopReason:'end_turn'});
 }
 if(m.method==='session/cancel'){log({method:m.method,pid:process.pid,sessionId:m.params.sessionId});return;}
 return refuse(-32601,'unsupported method '+m.method);
});`;

const previousConfig = process.env.OPENBOT_ACP_CONFIG;
let root: string | undefined;
afterEach(() => {
  if (previousConfig === undefined) delete process.env.OPENBOT_ACP_CONFIG;
  else process.env.OPENBOT_ACP_CONFIG = previousConfig;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

type Call = {
  method: string;
  pid: number;
  sessionId?: string;
  cwd?: string;
  tools?: string[];
  configId?: string;
  value?: string;
  previous?: string;
  restoredModel?: string | null;
  advertises?: boolean;
  effectiveModel?: string;
  currentModel?: string;
  loads?: number;
  prompts?: number;
  text?: string;
  outcome?: string;
};
type Sessions = Record<string, { model: string; cwd: string; prompts: number }>;

/** One operator profile, mapped to two roles with different models. */
function harness(
  mode: "modern" | "legacy" = "modern",
  adapter: { noCatalogueOnLoad?: boolean } = {},
) {
  root = mkdtempSync(join(tmpdir(), "ownbot-acp-role-models-"));
  const file = join(root, "acp.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        shared: {
          command: process.execPath,
          args: ["-e", fixture],
          workspaceRoot: root,
          env: {
            TEST_LOG: join(root, "calls.jsonl"),
            TEST_STATE: join(root, "sessions.json"),
            TEST_MODE: mode,
            ...(adapter.noCatalogueOnLoad ? { TEST_NO_CATALOGUE: "1" } : {}),
          },
          model: "small",
          mode: "agent",
          timeoutMs: 8000,
        },
      },
      agents: {
        coord: { profile: "shared", model: "large" },
        quant: "shared",
        ghost: { profile: "shared", model: "ghost-model" },
      },
    }),
  );
  process.env.OPENBOT_ACP_CONFIG = file;
  const profile = (agentId: string): AcpProfile =>
    acpModelSelectionFor(agentId)!.profile;
  const lines = (): string[] =>
    existsSync(join(root!, "calls.jsonl"))
      ? readFileSync(join(root!, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
  return {
    profile,
    /** The CLI's own session table: what the adapter actually holds per session id. */
    sessions: () =>
      JSON.parse(
        readFileSync(join(root!, "sessions.json"), "utf8"),
      ) as Sessions,
    events: () => lines().map((line) => JSON.parse(line) as Call),
    /** How much of the CLI's log exists right now; `since` returns what came after. */
    mark: () => lines().length,
    since: (from: number) =>
      lines()
        .slice(from)
        .map((line) => JSON.parse(line) as Call),
    make: (agentId: string, ownerId = "owner") =>
      new AcpAgent({
        ownerId,
        agentId,
        name: agentId,
        prompt: `standing ${agentId} instructions`,
        profile: profile(agentId),
        tools: async () => [
          {
            name: `${agentId}_lookup`,
            ref: `test/${agentId}-lookup`,
            description: "Lookup",
            parameters: z.object({}),
            execute: async () => "ok",
          },
        ],
      }),
  };
}

function input(threadId: string, tag: string, ids: string[]): RunAgentInput {
  return {
    threadId,
    runId: crypto.randomUUID(),
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: ids.map((id) => ({
      id,
      role: "user" as const,
      content: `${tag}-task-${id}`,
    })),
  };
}

function collect(
  agent: AcpAgent,
  request: RunAgentInput,
): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(request).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}
const textOf = (events: BaseEvent[]) =>
  events
    .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
    .map((e) => (e as { delta?: string }).delta ?? "")
    .join("");

describe("ACP roles sharing one CLI keep their model bound to their own session", () => {
  test("two roles on one CLI select different models into different sessions", async () => {
    const h = harness();
    expect(h.profile("coord").command).toBe(h.profile("quant").command);
    expect(h.profile("coord").args).toEqual(h.profile("quant").args);
    expect([h.profile("coord").model, h.profile("quant").model]).toEqual([
      "large",
      "small",
    ]);

    const coordText = textOf(
      await collect(h.make("coord"), input("thread", "coord", ["u1"])),
    );
    await Bun.sleep(20);
    const quantText = textOf(
      await collect(h.make("quant"), input("thread", "quant", ["u1"])),
    );
    await Bun.sleep(20);

    // The CLI answers with the model it holds for the session it was prompted on.
    expect(coordText).toContain("model=large");
    expect(quantText).toContain("model=small");
    expect(coordText).not.toBe(quantText);

    const started = h.events().filter((r) => r.method === "session/new");
    expect(started.map((r) => r.tools)).toEqual([
      ["coord_lookup"],
      ["quant_lookup"],
    ]);
    const [coord, quant] = started.map((r) => r.sessionId!);
    expect(coord).not.toBe(quant);
    expect(new Set(started.map((r) => r.cwd)).size).toBe(2);

    // Each selection names its own session and the advertised model config option.
    const selections = h
      .events()
      .filter((r) => r.method === "session/set_config_option")
      .map((r) => [r.sessionId!, r.configId!, r.value!]);
    expect(selections).toEqual([
      [coord, CONFIG_ID, "large"],
      [quant, CONFIG_ID, "small"],
    ]);

    // State on disk is per session, and each prompt saw only its own model and history.
    const sessions = h.sessions();
    expect(Object.keys(sessions).sort()).toEqual([coord, quant].sort());
    expect([sessions[coord]!.model, sessions[quant]!.model]).toEqual([
      "large",
      "small",
    ]);
    const prompts = h.events().filter((r) => r.method === "session/prompt");
    expect(prompts.map((r) => [r.sessionId!, r.effectiveModel!])).toEqual([
      [coord, "large"],
      [quant, "small"],
    ]);
    expect(prompts[0]!.text).toContain("coord-task-u1");
    expect(prompts[0]!.text).not.toContain("quant-task-u1");
    expect(prompts[1]!.text).toContain("quant-task-u1");
    expect(prompts[1]!.text).not.toContain("coord-task-u1");
    expect(h.events().some((r) => r.outcome)).toBe(false);
  });

  test("each role resumes its own session with its own model after the CLI restarts", async () => {
    const h = harness();
    // Both roles start on their own session in their own subprocess.
    const coordMark = h.mark();
    await collect(h.make("coord"), input("thread", "coord", ["u1"]));
    await Bun.sleep(20);
    const coordRun = h.since(coordMark);
    const coordSession = coordRun.find((r) => r.method === "session/new")!;
    expect(coordRun.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(coordSession.currentModel).toBe("small"); // the adapter's own default

    const quantMark = h.mark();
    await collect(h.make("quant"), input("thread", "quant", ["u1"]));
    await Bun.sleep(20);
    const quantRun = h.since(quantMark);
    const quantSession = quantRun.find((r) => r.method === "session/new")!;
    expect(quantSession.cwd).not.toBe(coordSession.cwd);

    // coord resumes: a new subprocess loads the same session and already holds "large" in its
    // own durable state, before the client has asked for anything in this process.
    const resumeMark = h.mark();
    const resumed = await collect(
      h.make("coord"),
      input("thread", "coord", ["u1", "u2"]),
    );
    await Bun.sleep(20);
    const resumedRun = h.since(resumeMark);
    expect(resumedRun.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(resumedRun[0]!.pid).not.toBe(coordSession.pid);
    expect(resumedRun[1]).toMatchObject({
      sessionId: coordSession.sessionId,
      cwd: coordSession.cwd,
      restoredModel: "large",
      loads: 1,
    });
    expect(resumedRun[3]).toMatchObject({
      sessionId: coordSession.sessionId,
      configId: CONFIG_ID,
      value: "large",
      previous: "large",
    });
    expect(resumedRun.at(-1)).toMatchObject({
      sessionId: coordSession.sessionId,
      effectiveModel: "large",
      prompts: 2,
    });
    expect(textOf(resumed)).toContain("model=large");
    expect(textOf(resumed)).toContain(`session=${coordSession.sessionId}`);
    // Only the new turn crossed, and only into coord's session.
    expect(resumedRun.at(-1)!.text).toContain("coord-task-u2");
    expect(resumedRun.at(-1)!.text).not.toContain("coord-task-u1");

    // quant resumes onto its own session, still "small", and creates nothing new.
    const secondQuantMark = h.mark();
    const quantResumed = await collect(
      h.make("quant"),
      input("thread", "quant", ["u1", "u2"]),
    );
    await Bun.sleep(20);
    const quantResume = h.since(secondQuantMark);
    expect(quantResume.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(quantResume[1]).toMatchObject({
      sessionId: quantSession.sessionId,
      cwd: quantSession.cwd,
      restoredModel: "small",
      loads: 1,
    });
    expect(quantResume[1]!.pid).not.toBe(coordRun[0]!.pid);
    expect(textOf(quantResumed)).toContain("model=small");
    expect(quantResume.at(-1)!.text).toContain("quant-task-u2");
    expect(quantResume.at(-1)!.text).not.toContain("coord-task-u2");

    const sessions = h.sessions();
    expect(Object.keys(sessions).sort()).toEqual(
      [coordSession.sessionId!, quantSession.sessionId!].sort(),
    );
    expect(sessions[coordSession.sessionId!]!.model).toBe("large");
    expect(sessions[quantSession.sessionId!]!.model).toBe("small");
    expect([
      sessions[coordSession.sessionId!]!.prompts,
      sessions[quantSession.sessionId!]!.prompts,
    ]).toEqual([2, 2]);
  });

  test("another owner on the same role cannot load or inherit the role's session", async () => {
    const h = harness();
    await collect(h.make("coord"), input("thread", "coord", ["u1"]));
    await Bun.sleep(20);
    const coordSession = h.events().find((r) => r.method === "session/new")!;

    const mark = h.mark();
    await collect(
      h.make("quant", "other-owner"),
      input("thread", "quant", ["u1"]),
    );
    await Bun.sleep(20);
    const run = h.since(mark);
    expect(run.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(run.some((r) => r.method === "session/load")).toBe(false);
    expect(run.filter((r) => r.outcome)).toEqual([]);
    const other = run.find((r) => r.method === "session/new")!;
    expect(other.sessionId).not.toBe(coordSession.sessionId);
    expect(other.cwd).not.toBe(coordSession.cwd);
    expect(other.tools).toEqual(["quant_lookup"]);
    const prompt = run.find((r) => r.method === "session/prompt")!;
    expect(prompt.effectiveModel).toBe("small");
    expect(prompt.text).toContain("quant-task-u1");
    expect(prompt.text).not.toContain("coord-task-u1");

    const sessions = h.sessions();
    expect(Object.keys(sessions).sort()).toEqual(
      [coordSession.sessionId!, other.sessionId!].sort(),
    );
    expect(sessions[other.sessionId!]!.model).toBe("small");
    expect(sessions[coordSession.sessionId!]!.model).toBe("large");
    expect(sessions[other.sessionId!]!.cwd).toBe(other.cwd!);
  });

  test("an administrator's model change starts a separate session instead of retuning the live one", async () => {
    const h = harness();
    await collect(h.make("coord"), input("thread", "coord", ["u1"]));
    await Bun.sleep(20);
    const large = h.events().find((r) => r.method === "session/new")!;
    expect(large.currentModel).toBe("small");

    saveAcpAgentModel(
      "coord",
      "thinking",
      acpModelSelectionFor("coord")!.revision,
    );
    expect(h.profile("coord").model).toBe("thinking");
    expect(h.profile("quant").model).toBe("small");

    const mark = h.mark();
    const switched = await collect(
      h.make("coord"),
      input("thread", "coord", ["u1", "u2"]),
    );
    await Bun.sleep(20);
    const run = h.since(mark);
    // Same owner, same bot, same thread: the changed model is a new session, not a retune of
    // the session that is answering on "large".
    expect(run.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/set_config_option",
      "session/prompt",
    ]);
    const thinking = run.find((r) => r.method === "session/new")!;
    expect(thinking.sessionId).not.toBe(large.sessionId);
    expect(thinking.cwd).not.toBe(large.cwd);
    expect(
      run.find((r) => r.method === "session/set_config_option"),
    ).toMatchObject({
      sessionId: thinking.sessionId,
      value: "thinking",
      previous: "small",
    });
    expect(textOf(switched)).toContain("model=thinking");
    expect(textOf(switched)).toContain(`session=${thinking.sessionId}`);

    const sessions = h.sessions();
    expect(sessions[large.sessionId!]!.model).toBe("large");
    expect(sessions[large.sessionId!]!.prompts).toBe(1);
    expect(sessions[thinking.sessionId!]!.model).toBe("thinking");
  });

  test("a model the shared CLI does not offer fails closed before any prompt", async () => {
    const h = harness();
    const mark = h.mark();
    await expect(
      collect(h.make("ghost"), input("thread", "ghost", ["u1"])),
    ).rejects.toThrow("não houve fallback para API");
    await Bun.sleep(20);
    const run = h.since(mark);
    // The catalogue the CLI advertised already excludes it, so the run stops at selection:
    // no config option is set and, above all, no prompt is sent to a session on another model.
    expect(run.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
    ]);
    expect(run.some((r) => r.method === "session/set_config_option")).toBe(
      false,
    );
    expect(run.some((r) => r.method === "session/prompt")).toBe(false);
    expect(
      Object.values(h.sessions()).some((s) => s.model === "ghost-model"),
    ).toBe(false);
  });

  test("a legacy adapter binds models per session through session/set_model", async () => {
    const h = harness("legacy");
    const coordText = textOf(
      await collect(h.make("coord"), input("thread", "coord", ["u1"])),
    );
    await Bun.sleep(20);
    const quantText = textOf(
      await collect(h.make("quant"), input("thread", "quant", ["u1"])),
    );
    await Bun.sleep(20);
    const events = h.events();
    expect(events.some((r) => r.method === "session/set_config_option")).toBe(
      false,
    );
    const started = events.filter((r) => r.method === "session/new");
    expect(started.map((r) => r.tools)).toEqual([
      ["coord_lookup"],
      ["quant_lookup"],
    ]);
    const coord = started[0]!.sessionId!;
    const quant = started[1]!.sessionId!;
    expect(coord).not.toBe(quant);
    // The legacy route still names the role's own session and its own model.
    expect(
      events
        .filter((r) => r.method === "session/set_model")
        .map((r) => [r.sessionId!, r.value!]),
    ).toEqual([
      [coord, "large"],
      [quant, "small"],
    ]);
    expect(h.sessions()[coord]!.model).toBe("large");
    expect(h.sessions()[quant]!.model).toBe("small");

    const mark = h.mark();
    const resumed = await collect(
      h.make("coord"),
      input("thread", "coord", ["u1", "u2"]),
    );
    await Bun.sleep(20);
    const run = h.since(mark);
    expect(run.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_mode",
      "session/set_model",
      "session/prompt",
    ]);
    expect(run[1]!.restoredModel).toBe("large");
    expect(textOf(resumed)).toContain("model=large");
    expect(coordText).toContain("model=large");
    expect(quantText).toContain("model=small");
  });

  test("a resume whose adapter stops advertising the catalogue never prompts on another model", async () => {
    const h = harness("modern", { noCatalogueOnLoad: true });
    await collect(h.make("coord"), input("thread", "coord", ["u1"]));
    await Bun.sleep(20);
    const coord = h.events().find((r) => r.method === "session/new")!;
    expect(coord.currentModel).toBe("small");
    expect(h.sessions()[coord.sessionId!]!.model).toBe("large");

    // This adapter answers session/load without configOptions, so ownbot has no advertised
    // config id and falls back to session/set_model, which a modern adapter does not offer.
    const mark = h.mark();
    await expect(
      collect(h.make("coord"), input("thread", "coord", ["u1", "u2"])),
    ).rejects.toThrow("não houve fallback para API");
    await Bun.sleep(20);
    const run = h.since(mark);
    expect(run[1]).toMatchObject({
      method: "session/load",
      restoredModel: "large",
      advertises: false,
    });
    // The point: nothing was prompted, so the turn cannot be answered on a model nobody chose,
    // and the session keeps the model coord selected earlier.
    expect(run.some((r) => r.method === "session/prompt")).toBe(false);
    expect(run.some((r) => r.method === "session/set_config_option")).toBe(
      false,
    );
    expect(run.at(-1)).toMatchObject({
      method: "session/set_model",
      outcome: "modern-adapter",
    });
    expect(h.sessions()[coord.sessionId!]!.model).toBe("large");
    expect(h.sessions()[coord.sessionId!]!.prompts).toBe(1);
  });
});
