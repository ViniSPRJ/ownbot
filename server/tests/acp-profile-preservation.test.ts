import { afterEach, describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { COMPUTER_GUIDANCE, PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { AcpAgent } from "../src/acp/agent";
import {
  buildAgents,
  builtInAgentConfiguration,
  builtInAgentPrompt,
  resolveRuntimeAgents,
  type RegisteredAgent,
} from "../src/copilot";
import { grantedToolGuidance, type GrantedTool } from "../src/plugins/tools";

/*
 * A Bot behind an ACP CLI must be told exactly what the same Bot would be told on the API path: its
 * package role (with the memory the loader already appended), the provenance rule, what it holds and
 * the computer guidance. The CLI below is a fake ACP agent that records the prompt it was handed and
 * the MCP tools it was bridged, and notes the moment it starts, so a run that must never reach a CLI
 * can be proven not to have.
 */
const fixture = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=v=>appendFileSync(process.env.TEST_LOG,JSON.stringify(v)+'\\n');
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
log({started:true});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line); const ok=result=>emit({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize')return ok({protocolVersion:1,agentCapabilities:{loadSession:false,mcpCapabilities:{http:true}}});
 if(m.method==='session/new'){
  const descriptor=m.params.mcpServers[0];
  const headers=Object.fromEntries(descriptor.headers.map(h=>[h.name,h.value]));headers['Content-Type']='application/json';
  const r=await fetch(descriptor.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  log({method:m.method,tools:(await r.json()).result.tools.map(t=>t.name)});
  return ok({sessionId:crypto.randomUUID()});
 }
 if(m.method==='session/prompt'){
  log({method:m.method,text:m.params.prompt[0].text});
  emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}}}});
  return ok({stopReason:'end_turn'});
 }
});`;

const saved = { ...process.env };
let root: string | undefined;
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Maps both Bots to the fake CLI; the private one is a misconfiguration the runtime must ignore. */
async function configureAcp(agentIds: string[]) {
  root = await mkdtemp(join(tmpdir(), "ownbot-acp-profile-"));
  const log = join(root, "cli.jsonl");
  const config = join(root, "acp.json");
  await writeFile(config, JSON.stringify({
    profiles: { fake: { command: process.execPath, args: ["-e", fixture], workspaceRoot: root, env: { TEST_LOG: log }, timeoutMs: 5000 } },
    agents: Object.fromEntries(agentIds.map((id) => [id, "fake"])),
  }), { mode: 0o600 });
  process.env.OPENBOT_ACP_CONFIG = config;
  return {
    records: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>),
    cliStarted: () => Bun.file(log).exists(),
  };
}

const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };
const vendors = ["google-drive", "slack"];
const memory = "Saved memory: the person prefers answers in Portuguese.";
const research: RegisteredAgent = {
  id: "research", name: "Research", type: "built_in", acpOwnerId: "owner-1",
  // What `createRuntimeAgentLoader` produces: the package role with the person's memory appended.
  systemPrompt: `Investigate policies.\n\n${memory}`,
};
const credito: RegisteredAgent = { id: "credito", name: "Crédito", type: "built_in", acpOwnerId: "owner-1", systemPrompt: "Private credit analysis." };
const assistant: RegisteredAgent = { id: "general-assistant", name: "General Assistant", type: "built_in", acpOwnerId: "owner-1", systemPrompt: "Be helpful." };

const tool = (name: string, description: string): GrantedTool => ({ name, ref: `test/${name}`, description, parameters: z.object({}), execute: async () => "ok" });
const drive = tool("mcp__google-drive__search_files", "Search Drive");
const messageBot = tool("message_bot", "Hand work to another Bot");

function input(threadId: string, text = "question"): RunAgentInput {
  return { threadId, runId: crypto.randomUUID(), state: {}, tools: [], context: [], forwardedProps: {}, messages: [{ id: crypto.randomUUID(), role: "user", content: text }] };
}
function collect(agent: { clone(): { run(input: RunAgentInput): { subscribe: Function } } }, request: RunAgentInput): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.clone().run(request).subscribe({ next: (e: BaseEvent) => events.push(e), error: reject, complete: () => resolve(events) });
  });
}

describe("ACP runtime preserves the built-in Bot's composed profile", () => {
  test("the CLI is handed the API path's prompt, with per-run handoff tools described and bridged", async () => {
    const cli = await configureAcp(["research"]);
    let loads = 0, handoffs = 0;
    const agents = await buildAgents(
      [research], model, null, undefined,
      async (botId) => { loads++; expect(botId).toBe("research"); return [drive]; },
      undefined, COMPUTER_GUIDANCE, async () => vendors, undefined, undefined,
      async (botId, run) => { handoffs++; expect(botId).toBe("research"); expect(run.threadId).toBe("thread"); return [messageBot]; },
    );
    const agent = agents.research;
    if (!agent) throw new Error("Expected the ACP agent");
    // No model credential was resolved and none is needed: ACP authenticates through the CLI.
    expect(agent).not.toBeInstanceOf(BuiltInAgent);

    const events = await collect(agent, input("thread"));
    expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
    const records = await cli.records();
    const prompt: string = records.find((r) => r.method === "session/prompt")!.text;

    // Exactly what the same Bot gets on the API path, from the same composition, for the same tools.
    const expected = builtInAgentPrompt(research, [drive, messageBot], COMPUTER_GUIDANCE, vendors);
    expect(builtInAgentConfiguration(research as never, model, "openai-secret", [drive, messageBot], COMPUTER_GUIDANCE, vendors).prompt).toBe(expected);
    expect(prompt.startsWith(expected)).toBe(true);

    // Each part, named, so a regression says which one went missing.
    expect(prompt).toContain("Investigate policies.");
    expect(prompt).toContain(memory);
    expect(prompt).toContain(PROVENANCE_GUIDANCE);
    expect(prompt).toContain(grantedToolGuidance([drive, messageBot], vendors));
    expect(prompt).toContain("- google-drive: search_files");
    expect(prompt).toContain("- this deployment: message_bot");
    expect(prompt).toContain("slack");
    expect(prompt).toContain(COMPUTER_GUIDANCE);
    // Order is part of the contract: grants before the browser prose, delegation rules after the role.
    expect(prompt.indexOf("google-drive")).toBeLessThan(prompt.indexOf(COMPUTER_GUIDANCE));
    expect(prompt.indexOf(COMPUTER_GUIDANCE)).toBeLessThan(prompt.indexOf("Use as ferramentas MCP ownbot"));
    expect(prompt).toContain("user: question");

    // The bridge offers the very tools the prompt describes, and nothing else.
    expect(records.find((r) => r.method === "session/new")!.tools).toEqual(["mcp__google-drive__search_files", "message_bot"]);
    // Grants are loaded once per request; the handoff tool is made per run.
    expect(loads).toBe(1);
    expect(handoffs).toBe(1);
  });

  test("without a handoff the Bot is a plain ACP agent and still carries the full prompt", async () => {
    const cli = await configureAcp(["research"]);
    const agents = await buildAgents([research], model, null, undefined, async () => [drive], undefined, undefined, async () => vendors);
    expect(agents.research).toBeInstanceOf(AcpAgent);
    await collect(agents.research!, input("thread"));
    const prompt: string = (await cli.records()).find((r) => r.method === "session/prompt")!.text;
    expect(prompt.startsWith(builtInAgentPrompt(research, [drive], undefined, vendors))).toBe(true);
    expect(prompt).toContain(PROVENANCE_GUIDANCE);
    // No computer on this deployment, so no promise of a browser.
    expect(prompt).not.toContain(COMPUTER_GUIDANCE);
  });

  test("public Bots not mapped to ACP are built exactly as before", async () => {
    await configureAcp(["research"]);
    const agents = await buildAgents([assistant, research], model, "openai-secret", undefined, async () => []);
    expect(agents["general-assistant"]).toBeInstanceOf(BuiltInAgent);
    expect(agents["general-assistant"]).not.toBeInstanceOf(AcpAgent);
    expect(agents.research).toBeInstanceOf(AcpAgent);
  });

  test("the model credential is resolved only for API-path Bots", async () => {
    await configureAcp(["research"]);
    process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
    let resolved = 0;
    const resolveKey = async () => { resolved++; return "openai-secret"; };
    await resolveRuntimeAgents(async () => [research, credito], model, resolveKey);
    expect(resolved).toBe(0);
    await resolveRuntimeAgents(async () => [research, credito, assistant], model, resolveKey);
    expect(resolved).toBe(1);
  });
});

describe("a private Bot wrongly mapped to ACP", () => {
  test("fails closed when the private model is not validated, without starting the CLI", async () => {
    const cli = await configureAcp(["credito"]);
    process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
    delete process.env.OPENBOT_PRIVATE_MODEL_VERIFIED;
    let loads = 0;
    const agents = await buildAgents([credito], model, null, undefined, async () => { loads++; return [drive]; }, undefined, COMPUTER_GUIDANCE, async () => vendors);
    expect(agents.credito).not.toBeInstanceOf(AcpAgent);
    expect(() => agents.credito!.run(input("private"))).toThrow("validação");
    expect(loads).toBe(0);
    expect(await cli.cliStarted()).toBe(false);
  });

  test("routes to the local private model and never executes the hosted CLI", async () => {
    const cli = await configureAcp(["credito"]);
    Object.assign(process.env, {
      OPENBOT_PRIVATE_AGENT_IDS: "credito", OPENBOT_NOTIFICATION_DELIVERY: "internal", OPENBOT_SELF_HOSTED: "true",
      OPENBOT_PRIVATE_MODEL_VERIFIED: "true", OPENBOT_PRIVATE_MODEL: "qwen", OPENBOT_PRIVATE_MODEL_BASE_URL: "http://127.0.0.1:8080/v1",
    });
    const original = globalThis.fetch;
    const requests: { url: string; body: any }[] = [];
    globalThis.fetch = (async (target, init) => {
      requests.push({ url: String(target), body: JSON.parse(String(init?.body)) });
      return new Response('data: {"id":"t","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{"role":"assistant","content":"Local"},"finish_reason":null}]}\n\ndata: {"id":"t","object":"chat.completion.chunk","created":1,"model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const agents = await buildAgents([credito], model, null, undefined, async () => { throw new Error("must not load tools"); }, undefined, COMPUTER_GUIDANCE, async () => vendors, undefined, undefined, async () => { throw new Error("must not hand off"); });
      expect(agents.credito).not.toBeInstanceOf(AcpAgent);
      const events = await collect(agents.credito!, input("private", "private question"));
      // The local runtime streams chunks; the answer came from the private model, not a CLI.
      expect(events.filter((e) => e.type === "TEXT_MESSAGE_CHUNK" || e.type === "TEXT_MESSAGE_CONTENT").map((e) => (e as any).delta).join("")).toBe("Local");
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect(requests.map((r) => r.url)).toEqual(["http://127.0.0.1:8080/v1/chat/completions"]);
      expect(requests[0]!.body.model).toBe("qwen");
      expect(JSON.stringify(requests)).not.toContain("google-drive");
    } finally {
      globalThis.fetch = original;
    }
    expect(await cli.cliStarted()).toBe(false);
  });
});
