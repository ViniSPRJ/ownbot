/**
 * On-prem threads without CopilotKit Intelligence.
 *
 * CopilotKit's v2 barrel pulls MCP/eventsource CJS that Bun cannot load, so AgentRunner is imported
 * from the runner module directly. Events are stored in bun:sqlite on this machine.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  EventType,
  type AbstractAgent,
  type BaseEvent,
  type Message,
} from "@ag-ui/client";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { ReplaySubject, type Observable } from "rxjs";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from "../node_modules/@copilotkit/runtime/dist/v2/runtime/runner/agent-runner.mjs";
import type { ThreadLock } from "./agents/handoff-delivery";
import type { ThreadReader } from "./channels/thread-routes";
import type { IntelligenceLike, RunnerLike } from "./routines/run-turn";

type Active = {
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
};

type StoredToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  /** AG-UI's nested shape. The platform's flat row is derived from it in `historyRow`. */
  toolCalls?: StoredToolCall[];
  toolCallId?: string;
};

type InboundMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
};

function openDb(dbPath: string): Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      event TEXT NOT NULL
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_thread_events_thread ON thread_events(thread_id, id)",
  );
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

function loadEvents(db: Database, threadId: string): BaseEvent[] {
  const rows = db
    .query(
      "SELECT event FROM thread_events WHERE thread_id = ? ORDER BY id ASC",
    )
    .all(threadId) as { event: string }[];
  const events: BaseEvent[] = [];
  for (const row of rows) {
    try {
      events.push(JSON.parse(row.event) as BaseEvent);
    } catch {
      /* skip a bad row rather than lose the thread */
    }
  }
  return events;
}

function appendEvents(
  db: Database,
  threadId: string,
  events: BaseEvent[],
): void {
  const insert = db.query(
    "INSERT INTO thread_events (thread_id, created_at, event) VALUES (?, ?, ?)",
  );
  const now = Date.now();
  const write = db.transaction((batch: BaseEvent[]) => {
    for (const event of batch) {
      insert.run(threadId, now, JSON.stringify(event));
    }
  });
  write(events);
}

function touchThread(db: Database, threadId: string, agentId: string): void {
  const now = Date.now();
  db.run(
    `
      INSERT INTO threads (id, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = CASE
          WHEN excluded.agent_id = '' THEN threads.agent_id
          ELSE excluded.agent_id
        END,
        updated_at = excluded.updated_at
    `,
    [threadId, agentId, now, now],
  );
}

function agentIdOf(agent: AbstractAgent): string {
  const id = (agent as { agentId?: unknown }).agentId;
  return typeof id === "string" ? id : "";
}

function knownMessageIds(events: BaseEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const messageId = (event as { messageId?: unknown }).messageId;
    if (typeof messageId === "string") ids.add(messageId);
    if ((event as { type?: string }).type === EventType.RUN_STARTED) {
      const messages = (
        event as { input?: { messages?: { id?: string }[] } }
      ).input?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (typeof message.id === "string") ids.add(message.id);
      }
    }
  }
  return ids;
}

function eventsForInboundMessages(
  threadId: string,
  runId: string,
  messages: InboundMessage[] | undefined,
  already: Set<string>,
): BaseEvent[] {
  if (!Array.isArray(messages)) return [];
  const out: BaseEvent[] = [];
  for (const message of messages) {
    if (typeof message.id !== "string" || already.has(message.id)) continue;
    if (message.role === "assistant") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");
    out.push({
      type: EventType.TEXT_MESSAGE_START,
      threadId,
      runId,
      messageId: message.id,
      role,
    } as BaseEvent);
    if (content.length > 0) {
      out.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId,
        runId,
        messageId: message.id,
        delta: content,
      } as BaseEvent);
    }
    out.push({
      type: EventType.TEXT_MESSAGE_END,
      threadId,
      runId,
      messageId: message.id,
    } as BaseEvent);
    already.add(message.id);
  }
  return out;
}

function messagesFromEvents(events: BaseEvent[]): StoredMessage[] {
  const byId = new Map<string, StoredMessage>();
  const order: string[] = [];
  const toolCallById = new Map<string, StoredToolCall>();
  const remember = (message: StoredMessage) => {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
      order.push(message.id);
    }
  };
  for (const event of events) {
    const type = (event as { type?: string }).type;
    if (type === EventType.RUN_STARTED) {
      const messages = (
        event as { input?: { messages?: InboundMessage[] } }
      ).input?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (typeof message.id !== "string") continue;
        remember({
          id: message.id,
          role: typeof message.role === "string" ? message.role : "user",
          content:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content ?? ""),
          ...(Array.isArray(message.toolCalls)
            ? { toolCalls: message.toolCalls as StoredToolCall[] }
            : {}),
          ...(typeof message.toolCallId === "string"
            ? { toolCallId: message.toolCallId }
            : {}),
        });
      }
      continue;
    }
    if (type === EventType.TEXT_MESSAGE_START) {
      const messageId = (event as { messageId?: string }).messageId;
      const role = (event as { role?: string }).role ?? "assistant";
      if (typeof messageId !== "string") continue;
      remember({ id: messageId, role, content: "" });
      continue;
    }
    if (type === EventType.TEXT_MESSAGE_CONTENT) {
      const messageId = (event as { messageId?: string }).messageId;
      const delta = (event as { delta?: string }).delta ?? "";
      if (typeof messageId !== "string") continue;
      const current = byId.get(messageId);
      if (current) current.content += delta;
      continue;
    }
    if (type === EventType.TOOL_CALL_START) {
      const { toolCallId, toolCallName, parentMessageId } = event as {
        toolCallId?: string;
        toolCallName?: string;
        parentMessageId?: string;
      };
      if (typeof toolCallId !== "string" || typeof toolCallName !== "string") {
        continue;
      }
      // The same resolution as @ag-ui/client's apply path: the named assistant message when there
      // is one, otherwise a fresh assistant message — named after the parent when that id is free,
      // after the call itself when the parent id belongs to a message of another role.
      const parent = parentMessageId ? byId.get(parentMessageId) : undefined;
      let owner = parent?.role === "assistant" ? parent : undefined;
      if (!owner) {
        const id = parentMessageId && !parent ? parentMessageId : toolCallId;
        remember({ id, role: "assistant", content: "", toolCalls: [] });
        owner = byId.get(id);
      }
      if (!owner) continue;
      const call: StoredToolCall = {
        id: toolCallId,
        type: "function",
        function: { name: toolCallName, arguments: "" },
      };
      (owner.toolCalls ??= []).push(call);
      toolCallById.set(toolCallId, call);
      continue;
    }
    if (type === EventType.TOOL_CALL_ARGS) {
      const { toolCallId, delta } = event as {
        toolCallId?: string;
        delta?: string;
      };
      if (typeof toolCallId !== "string") continue;
      const call = toolCallById.get(toolCallId);
      if (call) call.function.arguments += delta ?? "";
      continue;
    }
    // TOOL_CALL_END carries nothing the history needs; the call is complete once its args stopped.
    if (type === EventType.TOOL_CALL_RESULT) {
      const { messageId, toolCallId, content, role } = event as {
        messageId?: string;
        toolCallId?: string;
        content?: string;
        role?: string;
      };
      if (typeof messageId !== "string" || typeof toolCallId !== "string") {
        continue;
      }
      remember({
        id: messageId,
        role: role ?? "tool",
        content: typeof content === "string" ? content : "",
        toolCallId,
      });
    }
  }
  return ensureToolResults(
    order
      .map((id) => byId.get(id))
      .filter((row): row is StoredMessage => Boolean(row)),
  );
}

/** The least a message needs to say for `ensureToolResults` to read it. */
type ToolResultCandidate = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string }[];
  toolCallId?: string;
};

/**
 * Answer every tool call that has no tool message, keeping the order.
 *
 * A render-only frontend action never produces a TOOL_CALL_RESULT, and the client resends the
 * assistant message bare on the next turn, so both stored history and a run's inbound messages can
 * carry an unanswered call — which the model API refuses outright. The answer is the empty result
 * @copilotkit/core writes for a handler-less tool, under the `<toolCallId>-result` id its
 * finalizeRunEvents uses, inserted right after the assistant message that owns the call. A call
 * with a matching tool message anywhere in the list is left alone.
 */
export function ensureToolResults<T extends ToolResultCandidate>(
  messages: readonly T[],
): T[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
  }
  const out: T[] = [];
  for (const message of messages) {
    out.push(message);
    for (const call of message.toolCalls ?? []) {
      if (typeof call?.id !== "string" || answered.has(call.id)) continue;
      out.push({
        id: `${call.id}-result`,
        role: "tool",
        content: "",
        toolCallId: call.id,
      } as unknown as T);
    }
  }
  return out;
}

/**
 * One stored message as `IntelligenceLike.getThreadMessages` promises it: the platform's flat
 * `{ id, name, args }` tool calls, which `run-turn.ts` re-nests into AG-UI's shape itself.
 */
function historyRow(message: StoredMessage): Record<string, unknown> {
  const { toolCalls, ...rest } = message;
  if (!toolCalls) return rest;
  return {
    ...rest,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
    })),
  };
}

export async function fillConnectRequest(request: Request): Promise<Request> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.clone().json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }
  const filled = {
    ...body,
    threadId:
      typeof body.threadId === "string" ? body.threadId : crypto.randomUUID(),
    runId: typeof body.runId === "string" ? body.runId : crypto.randomUUID(),
    messages: Array.isArray(body.messages) ? body.messages : [],
    tools: Array.isArray(body.tools) ? body.tools : [],
    context: Array.isArray(body.context) ? body.context : [],
  };
  return new Request(request, { body: JSON.stringify(filled) });
}

export function withConnectDefaults(
  handler: {
    fetch: (request: Request) => Response | Promise<Response>;
  },
  basePath = "/api/copilotkit",
): Hono {
  const wrap = new Hono().basePath(basePath);
  wrap.all("*", async (context) => {
    let request = context.req.raw;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/connect")) {
      request = await fillConnectRequest(request);
    }
    return handler.fetch(request);
  });
  return wrap;
}

export class LocalAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private readonly active = new Map<string, Active>();
  private readonly db: Database;

  constructor(dbPath: string) {
    super();
    this.db = openDb(dbPath);
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const events: BaseEvent[] = [];
    this.active.set(request.threadId, { agent: request.agent, subject });
    touchThread(this.db, request.threadId, agentIdOf(request.agent));

    const runAgent = async () => {
      try {
        const already = knownMessageIds(loadEvents(this.db, request.threadId));
        const inbound = eventsForInboundMessages(
          request.threadId,
          request.input.runId,
          request.input.messages as InboundMessage[] | undefined,
          already,
        );
        let started = false;
        const emit = (event: BaseEvent) => {
          events.push(event);
          subject.next(event);
        };
        // What the client sent, not what it should have: an unanswered call in here reaches the
        // model API as-is. Answered here, and only here, so the persisted inbound above stays what
        // the client actually said.
        const input = {
          ...request.input,
          messages: ensureToolResults(
            (request.input.messages ?? []) as ToolResultCandidate[],
          ),
        } as typeof request.input;
        // AG-UI's runAgent reads the agent's own `messages`, not the input's: the runtime copied
        // the client's list onto the agent before handing it here, so answer the calls there too.
        if (Array.isArray(request.agent.messages)) {
          request.agent.messages = ensureToolResults(
            request.agent.messages as ToolResultCandidate[],
          ) as typeof request.agent.messages;
        }
        await request.agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (!started) {
              if ((event as { type?: string }).type !== EventType.RUN_STARTED) {
                emit({
                  type: EventType.RUN_STARTED,
                  threadId: request.threadId,
                  runId: request.input.runId,
                } as BaseEvent);
              }
              started = true;
            }
            emit(event);
          },
        });
        if (inbound.length > 0) {
          const startedAt = events.findIndex(
            (event) =>
              (event as { type?: string }).type === EventType.RUN_STARTED,
          );
          events.splice(
            startedAt >= 0 ? startedAt + 1 : 0,
            0,
            ...inbound,
          );
        }
        if (events.length > 0) {
          appendEvents(this.db, request.threadId, events);
        }
        subject.complete();
      } catch (error) {
        if (events.length > 0) {
          appendEvents(this.db, request.threadId, events);
        }
        subject.error(error);
      } finally {
        this.active.delete(request.threadId);
      }
    };
    void runAgent();
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    for (const event of loadEvents(this.db, request.threadId)) {
      subject.next(event);
    }
    const live = this.active.get(request.threadId);
    if (live) {
      live.subject.subscribe({
        next: (event) => subject.next(event),
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
    } else {
      subject.complete();
    }
    return subject.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.active.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const live = this.active.get(request.threadId);
    if (!live) return Promise.resolve(false);
    try {
      live.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  eventsFor(threadId: string): BaseEvent[] {
    return loadEvents(this.db, threadId);
  }

  hasThread(threadId: string): boolean {
    const row = this.db
      .query("SELECT 1 AS ok FROM thread_events WHERE thread_id = ? LIMIT 1")
      .get(threadId) as { ok: number } | null;
    return Boolean(row);
  }

  listThreads(): LocalThreadEndpointRecord[] {
    const rows = this.db
      .query(
        `
          SELECT
            e.thread_id AS id,
            COALESCE(t.agent_id, '') AS agent_id,
            MIN(e.created_at) AS created_at,
            MAX(e.created_at) AS updated_at
          FROM thread_events e
          LEFT JOIN threads t ON t.id = e.thread_id
          GROUP BY e.thread_id
          ORDER BY updated_at DESC
        `,
      )
      .all() as {
      id: string;
      agent_id: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: null,
      agentId: row.agent_id,
      organizationId: "",
      createdById: "",
      archived: false,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  getThreadMessages(threadId: string): Message[] {
    return messagesFromEvents(this.eventsFor(threadId)) as unknown as Message[];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return this.eventsFor(threadId);
  }

  getThreadState(_threadId: string): Record<string, unknown> | null {
    return null;
  }

  clearThreads(): void {
    this.db.run("DELETE FROM thread_events");
    this.db.run("DELETE FROM threads");
  }
}

export type LocalThreadStore = {
  runner: LocalAgentRunner;
  lock: ThreadLock;
  history: (input: {
    threadId: string;
    actorId: string;
  }) => Promise<readonly unknown[]>;
  intelligenceLike: IntelligenceLike;
  threadReader: ThreadReader;
};

/**
 * How long a held thread lock lasts without a renew. Mirrors copilot.ts's THREAD_LOCK_TTL_SECONDS
 * (not exported): a run that dies before `release` frees its thread after this, not at restart.
 */
const LOCAL_THREAD_LOCK_TTL_MS = 120_000;

export function createLocalThreadStore(
  dbPath: string,
  /** `now` is injectable so a test can age a lock without waiting two minutes. */
  options: { now?: () => number } = {},
): LocalThreadStore {
  const runner = new LocalAgentRunner(dbPath);
  const now = options.now ?? Date.now;
  const held = new Map<string, { runId: string; expiresAt: number }>();

  const lock: ThreadLock = {
    async acquire(input) {
      const current = held.get(input.threadId);
      if (
        current !== undefined &&
        current.runId !== input.runId &&
        current.expiresAt > now()
      ) {
        return null;
      }
      held.set(input.threadId, {
        runId: input.runId,
        expiresAt: now() + LOCAL_THREAD_LOCK_TTL_MS,
      });
      return { runId: input.runId };
    },
    async renew(input) {
      const current = held.get(input.threadId);
      if (current?.runId === input.runId) {
        current.expiresAt = now() + LOCAL_THREAD_LOCK_TTL_MS;
      }
    },
    async release(input) {
      if (held.get(input.threadId)?.runId === input.runId) {
        held.delete(input.threadId);
      }
    },
  };

  const history = async (input: { threadId: string }) =>
    messagesFromEvents(runner.eventsFor(input.threadId));

  const intelligenceLike: IntelligenceLike = {
    async getOrCreateThread() {
      return {};
    },
    async getThreadMessages(params) {
      return {
        messages: messagesFromEvents(runner.eventsFor(params.threadId)).map(
          historyRow,
        ) as never,
      };
    },
    async ɵacquireThreadLock(params) {
      const taken = await lock.acquire(params);
      if (!taken) {
        const error = new Error("Thread lock denied") as Error & {
          status: number;
        };
        error.status = 409;
        throw error;
      }
      return {};
    },
    async ɵrenewThreadLock(params) {
      await lock.renew(params);
    },
    async ɵcleanupThreadLock(params) {
      await lock.release(params);
    },
  };

  return {
    runner,
    lock,
    history,
    intelligenceLike,
    threadReader: async (threadId) =>
      runner.hasThread(threadId) ? "known" : "unknown",
  };
}

export function createLocalThreadReader(dbPath: string): ThreadReader {
  const db = openDb(dbPath);
  return async (threadId) => {
    const row = db
      .query("SELECT 1 AS ok FROM thread_events WHERE thread_id = ? LIMIT 1")
      .get(threadId) as { ok: number } | null;
    return row ? "known" : "unknown";
  };
}

export function asRunnerLike(runner: LocalAgentRunner): RunnerLike {
  return runner as unknown as RunnerLike;
}
