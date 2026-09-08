import { AcpPermissionGate } from "./permissions";
import { acpEnvironment, selectSessionModel } from "./models";
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { AcpStdioTransport } from "./transport";
import { createToolBridge } from "./tool-bridge";
import type { AcpProfile } from "./config";
import type { GrantedTool } from "../plugins/tools";
const running = new Set<string>();

type SessionRecord = { sessionId: string; lastMessageId: string | null; replyMessageId?: string; replyMessageIds?: string[] };
export class AcpAgent extends AbstractAgent {
  private stop?: () => void;
  constructor(private readonly options: {
    agentId: string; name: string; ownerId: string; prompt: string;
    profile: AcpProfile; tools: (input: RunAgentInput) => Promise<readonly GrantedTool[]>;
  }) { super({ agentId: options.agentId, description: options.name }); }
  clone(): AcpAgent { return new AcpAgent(this.options); }
  abortRun(): void { this.stop?.(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      const o = this.options;
      const key = createHash("sha256").update(JSON.stringify([o.ownerId,o.agentId,input.threadId,o.profile])).digest("hex");
      let transport: AcpStdioTransport | undefined;
      let bridge: Awaited<ReturnType<typeof createToolBridge>> | undefined;
      let sessionId: string | undefined;
      let ownsLock = false;
      let phase = "lock";
      let stopReason: string | undefined;
      let cancelled = false, finished = false, textStarted = false, accepting = false;
      let messageId: string | undefined;
      const replyMessageIds: string[] = [];
      const seenToolCalls = new Set<string>();
      const emit = (event: Record<string, unknown>) => { if (!subscriber.closed) subscriber.next(event as BaseEvent); };
      const endText = () => {
        if (!textStarted || !messageId) return;
        emit({type:"TEXT_MESSAGE_END",messageId});
        textStarted = false;
      };
      const stop = () => {
        if (cancelled || finished) return;
        cancelled = true;
        if (sessionId && transport) void transport.cancel(sessionId).catch(() => {}).finally(() => transport?.close());
        else transport?.close();
        if (!subscriber.closed) subscriber.error(new Error("Execução ACP cancelada."));
      };
      this.stop = stop;
      void (async () => {
        if (running.has(key)) throw new Error("Este agente já está trabalhando nesta conversa.");
        running.add(key); ownsLock = true;
        try {
          const cwd = join(o.profile.workspaceRoot, key);
          await mkdir(cwd, { recursive: true, mode: 0o700 });
          const stateFile = join(cwd, ".ownbot-session.json");
          let saved: SessionRecord | undefined;
          try { saved = JSON.parse(await readFile(stateFile,"utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          phase = "tools";
          const tools = await o.tools(input);
          const permissions = new AcpPermissionGate(o.profile.provider ?? "codex", new Set(tools.map(tool=>tool.name)));
          bridge = await createToolBridge(tools);
          if (cancelled) return;
          const env = acpEnvironment(o.profile);
          transport = new AcpStdioTransport({ command:o.profile.command,args:o.profile.args,cwd,env,
            requestTimeoutMs:o.profile.timeoutMs,
            onRequest: (method, params) => {
              // Native CLI permissions are never blanket-approved by ownbot.
              if (method === "session/request_permission") {
                return permissions.decide(params, accepting ? sessionId : undefined);
              }
              throw new Error("Unsupported ACP client operation");
            },
            onNotification: (method, value) => {
              if (!accepting || method !== "session/update") return;
              const event = value as {sessionId?:string;update?:{toolCallId?:string;rawInput?:{server?:string;tool?:string};_meta?:{is_mcp_tool_call?:boolean};sessionUpdate?:string;status?:string;content?:{type?:string;text?:string}}};
              if (event.sessionId !== sessionId) return;
              permissions.observe(event.update);
              const update = event.update;
              // Split commentary at the beginning of a new tool call, never on late completion
              // updates that may arrive while the final answer is already streaming.
              if (update?.toolCallId && !seenToolCalls.has(update.toolCallId) &&
                (update.sessionUpdate === "tool_call" ||
                  (update.sessionUpdate === "tool_call_update" && (update.status === "pending" || update.status === "in_progress")))) {
                seenToolCalls.add(update.toolCallId);
                endText();
              }
              if (event.update?.sessionUpdate === "agent_message_chunk" && event.update.content?.type === "text" && event.update.content.text) {
                if (!textStarted) { messageId = crypto.randomUUID(); replyMessageIds.push(messageId); emit({type:"TEXT_MESSAGE_START",messageId,role:"assistant"}); textStarted=true; }
                emit({type:"TEXT_MESSAGE_CONTENT",messageId,delta:event.update.content.text});
              }
            },
          });
          phase = "initialize";
          const init = await transport.request<{protocolVersion:number;agentCapabilities?:{loadSession?:boolean;mcpCapabilities?:{http?:boolean}}}>("initialize",{protocolVersion:1,clientCapabilities:{},clientInfo:{name:"ownbot",version:"0.1.0"}});
          if (init.protocolVersion !== 1) throw new Error("Versão ACP não suportada");
          if (!init.agentCapabilities?.mcpCapabilities?.http) throw new Error("Este agente ACP não oferece MCP HTTP para as ferramentas do ownbot.");
          phase = "session";
          let fromIndex = 0;
          let sessionConfiguration: { configOptions?: unknown; models?: unknown } = {};
          const previous = saved ? input.messages.findIndex(m=>m.id===saved.lastMessageId) : -1;
          if (saved && previous >= 0 && init.agentCapabilities?.loadSession) {
            sessionConfiguration = await transport.request("session/load",{sessionId:saved.sessionId,cwd,mcpServers:[bridge.descriptor]});
            sessionId=saved.sessionId;
            if (previous>=0) fromIndex=previous+1;
          } else {
            const session=await transport.request<{sessionId:string;configOptions?:unknown;models?:unknown}>("session/new",{cwd,mcpServers:[bridge.descriptor]});
            sessionConfiguration = session;
            sessionId=session.sessionId;
          }
          if (!sessionId) throw new Error("Agente ACP não retornou uma sessão");
          if (o.profile.mode) await transport.request("session/set_mode",{sessionId,modeId:o.profile.mode});
          if (o.profile.model) await selectSessionModel(transport, sessionId, sessionConfiguration, o.profile.model);
          if (cancelled) return;
          emit({type:"RUN_STARTED",threadId:input.threadId,runId:input.runId});
          const previousReplies = new Set([...(saved?.replyMessageIds ?? []), saved?.replyMessageId].filter((id): id is string => typeof id === "string"));
          const messages=input.messages.slice(fromIndex).filter(m=>m.role!=="system" && !(fromIndex > 0 && previousReplies.has(m.id)));
          const context=messages.map(m=>`${m.role}: ${typeof m.content==="string"?m.content:JSON.stringify(m.content??"")}`).join("\n\n");
          accepting=true;
          phase = "prompt";
          const result = await transport.request<{stopReason:string}>("session/prompt",{sessionId,prompt:[{type:"text",text:o.prompt+"\n\nUse as ferramentas MCP ownbot para delegar e acessar os recursos concedidos. Permissões nativas adicionais podem ser recusadas. Quando message_bot aceitar uma delegação, informe o ID e encerre o turno; o ownbot entregará o resultado depois. Não mantenha o turno aberto consultando status repetidamente.\n\n"+context}]});
          accepting=false;
          stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(result.stopReason) ? result.stopReason : "unknown";
          if (result.stopReason !== "end_turn") throw new Error("A CLI não concluiu o turno.");
          if (cancelled) return;
          if (!textStarted || !messageId) throw new Error("A CLI terminou sem retornar uma resposta final após as ferramentas.");
          endText();
          emit({type:"CUSTOM",name:"ownbot.acp.final-message",value:{messageId}});
          phase = "persist";
          const temporary=stateFile+".tmp";
          await writeFile(temporary,JSON.stringify({sessionId,lastMessageId:input.messages.at(-1)?.id??null,replyMessageId:messageId,replyMessageIds}),{mode:0o600});
          await rename(temporary,stateFile);
          finished = true;
          transport.close(); transport = undefined;
          await bridge.close(); bridge = undefined;
          running.delete(key); ownsLock = false;
          emit({type:"RUN_FINISHED",threadId:input.threadId,runId:input.runId});
          subscriber.complete();
        } finally {
          if (ownsLock) running.delete(key); transport?.close(); await bridge?.close();
          if(this.stop===stop)this.stop=undefined;
        }
      })().catch(() => {
        console.warn(JSON.stringify({type:"acp-run-failed",agentId:o.agentId,runId:input.runId,phase,stopReason}));
        if (!cancelled) subscriber.error(new Error("A execução ACP não foi concluída. Verifique autenticação, perfil e disponibilidade da CLI; não houve fallback para API."));
      });
      return stop;
    });
  }
}
