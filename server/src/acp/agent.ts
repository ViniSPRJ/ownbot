import { AcpPermissionGate } from "./permissions";
import { acpFailureCause } from "./failure";
import { acpEnvironment, selectSessionModel, sessionModels } from "./models";
import { type AcpSessionState, type FreshReason, legacySessionKey, parseSessionState, planSessionAnchor,
  resolveWorkspaceDirectory, type SessionSelection, selectionFromProfile, sessionIdentityKey, writeSessionState } from "./session-state";
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AcpRpcError, AcpStdioTransport } from "./transport";
import { createToolBridge } from "./tool-bridge";
import { acpToolsForProvider } from "./tool-names";
import type { AcpProfile } from "./config";
import type { GrantedTool } from "../plugins/tools";
const running = new Set<string>();

/** What the person sees when a turn does not continue the session they were in. */
export type AcpSessionNotice = {
  /** The notice describes one turn, and a turn belongs to a thread. */
  threadId: string;
  runId: string;
  resumed: boolean;
  freshReason?: FreshReason;
  /**
   * The selection asked of this turn, not the id the CLI confirmed.
   *
   * Kept so existing readers of `model` keep seeing the requested choice. The confirmed
   * effective id, when the CLI actually reported one, is `resolvedModel`.
   */
  model: string | null;
  requestedModel: string | null;
  /** Confirmed effective id, or null when the CLI did not report a matching current model. */
  resolvedModel: string | null;
  executor: "acp";
  provider: string;
  profileId: string;
};
export class AcpAgent extends AbstractAgent {
  private stop?: () => void;
  constructor(private readonly options: {
    agentId: string; name: string; ownerId: string; prompt: string;
    profile: AcpProfile; tools: (input: RunAgentInput) => Promise<readonly GrantedTool[]>;
    /** Drop the anchor and open a new session on this turn, keeping the conversation. */
    restart?: boolean;
    /** Reports, before the first token, whether this turn resumed or opened a session. */
    onSession?: (notice: AcpSessionNotice) => void;
    /**
     * The model this conversation selected, if it selected one.
     *
     * Asked per thread rather than fixed at construction, because one agent instance answers many
     * conversations. The resolver re-checks membership and the operator revision on the way in, and
     * returns null for "follow the operator's default", which is what a dropped or absent choice means.
     */
    resolveModel?: (threadId: string) => Promise<string | null>;
  }) { super({ agentId: options.agentId, description: options.name }); }
  clone(): AcpAgent { return new AcpAgent(this.options); }
  abortRun(): void { this.stop?.(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      const o = this.options;
      // Identity only. The model is not part of the workspace, and changing it must not move the
      // directory or discard the anchor: see session-state.ts.
      const key = sessionIdentityKey({ ownerId:o.ownerId, agentId:o.agentId, threadId:input.threadId });
      // The conversation's own choice if it made one and still may, otherwise the operator's. Assigned
      // inside the async body, before the anchor is planned, because which model answers decides which
      // session is hers.
      let selection: SessionSelection = selectionFromProfile(o.profile);
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
        /*
         * The workspace follows the conversation, not the model.
         *
         * A conversation that already has a directory keeps it, anchor and files together, under the name
         * it was created with. Only new conversations get the identity key. Swapping the model mid-thread
         * changes neither.
         */
        const cwd = (await resolveWorkspaceDirectory({
          workspaceRoot: o.profile.workspaceRoot,
          identityKey: key,
          legacyKey: legacySessionKey({ ownerId:o.ownerId, agentId:o.agentId, threadId:input.threadId }, o.profile),
          exists: async directory => stat(directory).then(() => true, () => false),
        })).directory;
        const stateFile = join(cwd, ".ownbot-session.json");
        const persist = async (value: AcpSessionState) => writeSessionState(stateFile, value);
        try {
          // Explicit null still means the operator default. An unexpected throw must not: swallowing
          // it used to start that default as if the conversation had no choice. Fail before tools or
          // the CLI so the structured warning can name this phase without the resolver's text.
          if (o.resolveModel) phase = "model_resolution";
          const chosen = o.resolveModel ? await o.resolveModel(input.threadId) : null;
          selection = { ...selection, model: chosen ?? o.profile.model ?? null };
          await mkdir(cwd, { recursive: true, mode: 0o700 });
          let saved: AcpSessionState | undefined;
          let unreadable = false;
          try {
            const parsed = parseSessionState(await readFile(stateFile,"utf8"), selection);
            saved = parsed.state;
            unreadable = parsed.freshReason === "record_unreadable";
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          phase = "tools";
          const { tools, guidance: toolGuidance } = acpToolsForProvider(o.profile.provider ?? "codex", await o.tools(input));
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
              if (o.profile.provider === "cursor" &&
                (method === "cursor/ask_question" || method === "cursor/create_plan")) {
                // Headless turns cannot obtain an interactive decision. Explicitly cancel
                // rather than letting the CLI wait indefinitely or approving a plan.
                return { outcome: "cancelled" };
              }
              throw new Error("Unsupported ACP client operation");
            },
            onNotification: (method, value) => {
              if (!accepting || method !== "session/update") return;
              const event = value as {sessionId?:string;update?:{toolCallId?:string;rawInput?:{server?:string;tool?:string};_meta?:{is_mcp_tool_call?:boolean;jetbrains?:{air?:{sessionFailure?:{severity?:unknown;category?:unknown}}}};sessionUpdate?:string;status?:string;content?:{type?:string;text?:string}}};
              if (event.sessionId !== sessionId) return;
              permissions.observe(event.update);
              const update = event.update;
              const notice = update?._meta?.jetbrains?.air?.sessionFailure;
              if (update?.sessionUpdate === "session_info_update" && notice) {
                // Negotiated Codex notices are diagnostics, never assistant prose or a final answer.
                // Do not log their title/details: transport errors can contain private URLs or tokens.
                console.warn(JSON.stringify({type:"acp-session-notice",agentId:o.agentId,runId:input.runId,
                  severity:notice.severity === "error" ? "error" : "warning"}));
              }
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
          // codex-acp 1.10 negotiates typed notices through this extension; without it, provider
          // warnings arrive as agent_message_chunk and permanently contaminate chat/history.
          const clientCapabilities = (o.profile.provider ?? "codex") === "codex"
            ? {_meta:{jetbrains:{air:{version:1,capabilities:["sessionFailure"]}}}}
            : {};
          const init = await transport.request<{protocolVersion:number;agentCapabilities?:{loadSession?:boolean;mcpCapabilities?:{http?:boolean}}}>("initialize",{protocolVersion:1,clientCapabilities,clientInfo:{name:"ownbot",version:"0.1.0"}});
          if (init.protocolVersion !== 1) throw new Error("Versão ACP não suportada");
          if (!init.agentCapabilities?.mcpCapabilities?.http) throw new Error("Este agente ACP não oferece MCP HTTP para as ferramentas do ownbot.");
          phase = "session";
          const plan = planSessionAnchor({ state:saved, unreadable,
            loadSupported: init.agentCapabilities?.loadSession === true,
            selection, messages:input.messages, restartRequested: o.restart === true });
          let sessionConfiguration: { configOptions?: unknown; models?: unknown } = {};
          let resumed = false;
          let freshReason = plan.freshReason;
          if (plan.load && plan.sessionId) {
            try {
              sessionConfiguration = await transport.request("session/load",{sessionId:plan.sessionId,cwd,mcpServers:[bridge.descriptor]});
              sessionId = plan.sessionId;
              resumed = true;
            } catch (error) {
              /*
               * A dead anchor is cleared here, and the run continues in a new session.
               *
               * It used to fail. That was not merely unfriendly: the anchor stayed on disk, so every
               * later turn tried to load the same dead session and failed the same way, and the person
               * watched the same error on a conversation whose history was perfectly intact in ownbot. The
               * anchor outliving the CLI's ability to open it is the one state that must not persist.
               *
               * Clearing it before opening the replacement is the point. Clearing it only after success
               * would leave the poison in place for whatever fails between the two.
               */
              if (!(error instanceof AcpRpcError) && !(error instanceof Error)) throw error;
              freshReason = "anchor_dead";
              await persist({ version:2, sessionId:null, resumable:false, selection,
                lastMessageId: saved?.lastMessageId ?? null,
                ...(saved?.replyMessageId ? {replyMessageId:saved.replyMessageId} : {}),
                replyMessageIds: saved?.replyMessageIds ?? [], updatedAt: new Date().toISOString() });
              sessionId = undefined;
            }
          }
          if (!resumed) {
            const session=await transport.request<{sessionId:string;configOptions?:unknown;models?:unknown}>("session/new",{cwd,mcpServers:[bridge.descriptor]});
            sessionConfiguration = session;
            sessionId=session.sessionId;
          }
          if (!sessionId) throw new Error("Agente ACP não retornou uma sessão");
          if (o.profile.mode) await transport.request("session/set_mode",{sessionId,modeId:o.profile.mode});
          // A requested selection is confirmed only by the CLI's response to the change. With no
          // selection, the current model advertised on session/new or session/load is the confirmation.
          // After an unconfirmed legacy change, the previously advertised current value is not reused.
          let resolvedModel: string | null = null;
          if (selection.model) {
            resolvedModel = await selectSessionModel(transport, sessionId, sessionConfiguration, selection.model);
          } else {
            resolvedModel = sessionModels(sessionConfiguration).currentModel;
          }
          if (cancelled) return;
          emit({type:"RUN_STARTED",threadId:input.threadId,runId:input.runId});
          /*
           * Whether this turn continued the session or opened one, reported out of band.
           *
           * Deliberately not an event in the AG-UI stream: every consumer of that stream would have to
           * learn to ignore it, and a stream is a poor place to learn a fact you need even when the stream
           * never opened. The caller audits it, and the interface reads it back from the session endpoint.
           * A conversation that quietly restarted looks exactly like one that never restarted, and only one
           * of those has its history in front of the model.
           */
          o.onSession?.({
            threadId: input.threadId,
            runId: input.runId,
            resumed,
            freshReason,
            model: selection.model,
            requestedModel: selection.model,
            resolvedModel,
            executor: "acp",
            provider: o.profile.provider ?? "codex",
            profileId: o.profile.profileId,
          });
          const { fromIndex, previousReplyIds: previousReplies } = plan;
          const messages=input.messages.slice(fromIndex).filter(m=>m.role!=="system" && !(fromIndex > 0 && previousReplies.has(m.id)));
          const context=messages.map(m=>`${m.role}: ${typeof m.content==="string"?m.content:JSON.stringify(m.content??"")}`).join("\n\n");
          accepting=true;
          phase = "prompt";
          const result = await transport.request<{stopReason:string}>("session/prompt",{sessionId,prompt:[{type:"text",text:o.prompt+"\n\n"+toolGuidance+"\n\nUse as ferramentas MCP ownbot para delegar e acessar os recursos concedidos. Permissões nativas adicionais podem ser recusadas. Quando message_bot aceitar uma delegação, informe o ID e encerre o turno; o ownbot entregará o resultado depois. Não mantenha o turno aberto consultando status repetidamente.\n\n"+context}]});
          accepting=false;
          stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(result.stopReason) ? result.stopReason : "unknown";
          if (result.stopReason !== "end_turn") throw new Error("A CLI não concluiu o turno.");
          if (cancelled) return;
          if (!textStarted || !messageId) throw new Error("A CLI terminou sem retornar uma resposta final após as ferramentas.");
          endText();
          emit({type:"CUSTOM",name:"ownbot.acp.final-message",value:{messageId}});
          phase = "persist";
          await persist({ version:2, sessionId, resumable:true, selection,
            lastMessageId: input.messages.at(-1)?.id ?? null, replyMessageId: messageId, replyMessageIds,
            updatedAt: new Date().toISOString() });
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
      })().catch((error) => {
        // The cause is one word from a fixed set, derived only from our own guards: the CLI's error
        // text can carry prompt content, paths and credential-helper output, and is never logged.
        console.warn(JSON.stringify({type:"acp-run-failed",agentId:o.agentId,runId:input.runId,phase,stopReason,cause:acpFailureCause(error)}));
        if (!cancelled) subscriber.error(new Error("A execução ACP não foi concluída. Verifique autenticação, perfil e disponibilidade da CLI; não houve fallback para API."));
      });
      return stop;
    });
  }
}
