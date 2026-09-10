import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { EventType, type AbstractAgent } from "@ag-ui/client";
import type { Observable } from "rxjs";
import {
  LocalAgentRunner,
  createLocalThreadStore,
  ensureToolResults,
  fillConnectRequest,
} from "../src/local-threads";

function collect<T>(source: Observable<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    source.subscribe({
      next: (item) => items.push(item),
      error: reject,
      complete: () => resolve(items),
    });
  });
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-threads-"));
  dirs.push(dir);
  return join(dir, "threads.db");
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAgent(): AbstractAgent {
  return {
    agentId: "coord",
    async runAgent(_input, { onEvent }) {
      onEvent({
        event: {
          type: EventType.RUN_STARTED,
          threadId: "t1",
          runId: "r1",
        },
      });
      onEvent({
        event: {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "a1",
          role: "assistant",
        },
      });
      onEvent({
        event: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "a1",
          delta: "pong",
        },
      });
      onEvent({
        event: {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "a1",
        },
      });
      onEvent({
        event: {
          type: EventType.RUN_FINISHED,
          threadId: "t1",
          runId: "r1",
        },
      });
    },
    abortRun() {},
  } as unknown as AbstractAgent;
}

for (const partial of [false, true]) {
  test(`failed/cancelled turns retain the user before partial output: ${partial}`, async () => {
    const dbPath = tempDb();
    const runner = new LocalAgentRunner(dbPath);
    const agent = {
      agentId: "coord",
      async runAgent(_input: unknown, { onEvent }: any) {
        if (partial) {
          onEvent({ event: { type: EventType.RUN_STARTED, threadId: "cancelled", runId: "r1" } });
          onEvent({ event: { type: EventType.TEXT_MESSAGE_START, messageId: "partial", role: "assistant" } });
          onEvent({ event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "partial", delta: "partial answer" } });
        }
        throw new Error("cancelled");
      },
      abortRun() {},
    } as unknown as AbstractAgent;
    const input = { threadId: "cancelled", runId: "r1", messages: [{ id: "u1", role: "user" as const, content: "first question" }], tools: [], context: [], state: {}, forwardedProps: {} };
    await expect(collect(runner.run({ threadId: input.threadId, agent, input }))).rejects.toThrow("cancelled");
    const restored = new LocalAgentRunner(dbPath);
    expect(restored.getThreadMessages(input.threadId).map(m=>m.content)).toEqual(partial ? ["first question", "partial answer"] : ["first question"]);
    await collect(restored.run({ threadId: input.threadId, agent: fakeAgent(), input: { ...input, runId: "r2", messages: [...input.messages, { id: "u2", role: "user", content: "next question" }] } }));
    const messages = restored.getThreadMessages(input.threadId);
    expect(messages.filter(m=>m.id==="u1")).toHaveLength(1);
    expect(messages.map(m=>m.content)).toEqual(partial ? ["first question", "partial answer", "next question", "pong"] : ["first question", "next question", "pong"]);
  });
}

for (const shown of [[], [{ id: "internal", role: "user", content: "Code returned a result." }]]) {
  test(`handoff model instructions stay out of live replay and persisted history: ${shown.length}`, async () => {
    const dbPath = tempDb();
    const runner = new LocalAgentRunner(dbPath);
    const input = { threadId: "handoff", runId: "r1", messages: [{ id: "internal", role: "user" as const, content: "PRIVATE ORCHESTRATION INSTRUCTIONS" }], tools: [], context: [], state: {}, forwardedProps: {} };
    const agent = {
      agentId: "coord",
      async runAgent(received: any, { onEvent }: any) {
        expect(received.messages).toEqual(input.messages);
        onEvent({ event: { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, input: received } });
        onEvent({ event: { type: EventType.TEXT_MESSAGE_START, messageId: "reply", role: "assistant" } });
        onEvent({ event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: "Result: 323" } });
        onEvent({ event: { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } });
      },
      abortRun() {},
    } as unknown as AbstractAgent;
    const live = await collect(runner.run({ threadId: input.threadId, agent, input, persistedInputMessages: shown }));
    const restored = new LocalAgentRunner(dbPath);
    const replay = await collect(restored.connect({ threadId: input.threadId }));
    expect(JSON.stringify(live)).not.toContain("PRIVATE ORCHESTRATION");
    expect(JSON.stringify(replay)).not.toContain("PRIVATE ORCHESTRATION");
    expect(restored.getThreadMessages(input.threadId).map(m=>m.content)).toEqual([...shown.map(m=>m.content), "Result: 323"]);
  });
}

describe("local SQLite threads", () => {
  test("stores inbound user text and replays it after a new runner opens the same db", async () => {
    const dbPath = tempDb();
    const first = new LocalAgentRunner(dbPath);
    const live = await collect(
      first.run({
        threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        agent: fakeAgent(),
        input: {
          threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          runId: "r1",
          messages: [{ id: "u1", role: "user", content: "say pong" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
    );
    expect(live[0]?.type).toBe(EventType.RUN_STARTED);

    const second = new LocalAgentRunner(dbPath);
    expect(second.hasThread("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(true);
    const messages = second.getThreadMessages(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(
      messages.map((row) => ({ role: row.role, content: row.content })),
    ).toEqual([
      { role: "user", content: "say pong" },
      { role: "assistant", content: "pong" },
    ]);
    expect(second.listThreads()[0]?.agentId).toBe("coord");

    const replayed = await collect(
      second.connect({ threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
    );
    expect(replayed[0]?.type).toBe(EventType.RUN_STARTED);
    const userText = replayed
      .filter(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          (event as { messageId?: string }).messageId === "u1",
      )
      .map((event) => (event as { delta?: string }).delta)
      .join("");
    expect(userText).toBe("say pong");
  });

  test("live stream starts with RUN_STARTED even if the agent emits text first", async () => {
    const dbPath = tempDb();
    const runner = new LocalAgentRunner(dbPath);
    const agent = {
      agentId: "coord",
      async runAgent(_input, { onEvent }) {
        onEvent({
          event: {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "a1",
            role: "assistant",
          },
        });
        onEvent({
          event: {
            type: EventType.RUN_FINISHED,
            threadId: "t1",
            runId: "r1",
          },
        });
      },
      abortRun() {},
    } as unknown as AbstractAgent;
    const live = await collect(
      runner.run({
        threadId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        agent,
        input: {
          threadId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          runId: "r1",
          messages: [{ id: "u1", role: "user", content: "hello" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
    );
    expect(live[0]?.type).toBe(EventType.RUN_STARTED);
  });

  test("history keeps tool calls and tool results in AG-UI's shape", async () => {
    const threadId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const store = createLocalThreadStore(tempDb());
    const agent = {
      agentId: "coord",
      async runAgent(_input, { onEvent }) {
        const emit = (event: Record<string, unknown>) =>
          onEvent({ event: event as never });
        emit({ type: EventType.RUN_STARTED, threadId, runId: "r1" });
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "a1",
          role: "assistant",
        });
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "a1",
          delta: "Checking",
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: "a1" });
        emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: "c1",
          toolCallName: "lookup",
          parentMessageId: "a1",
        });
        emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "c1",
          delta: '{"q":',
        });
        emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "c1",
          delta: '"x"}',
        });
        emit({ type: EventType.TOOL_CALL_END, toolCallId: "c1" });
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tr1",
          toolCallId: "c1",
          content: "found",
        });
        // No parent: the call becomes its own assistant message, named after the call. No result
        // either: history retains the call but must not invent a successful result.
        emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: "c2",
          toolCallName: "notify",
        });
        emit({ type: EventType.TOOL_CALL_END, toolCallId: "c2" });
        emit({ type: EventType.RUN_FINISHED, threadId, runId: "r1" });
      },
      abortRun() {},
    } as unknown as AbstractAgent;
    await collect(
      store.runner.run({
        threadId,
        agent,
        input: {
          threadId,
          runId: "r1",
          messages: [{ id: "u1", role: "user", content: "ask" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
    );

    expect(store.runner.getThreadMessages(threadId)).toEqual([
      { id: "u1", role: "user", content: "ask" },
      {
        id: "a1",
        role: "assistant",
        content: "Checking",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"x"}' },
          },
        ],
      },
      { id: "tr1", role: "tool", content: "found", toolCallId: "c1" },
      {
        id: "c2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c2",
            type: "function",
            function: { name: "notify", arguments: "" },
          },
        ],
      },
    ] as never);

    // The routine runner reads the platform's flat row and re-nests it itself.
    const { messages } = await store.intelligenceLike.getThreadMessages({
      threadId,
      userId: "u",
    });
    expect(messages[1]?.toolCalls).toEqual([
      { id: "c1", name: "lookup", args: '{"q":"x"}' },
    ]);
    expect(messages[2]?.toolCallId).toBe("c1");
    expect(messages.map((row) => row.id)).toEqual(["u1", "a1", "tr1", "c2"]);
    expect(messages).toHaveLength(4);
  });

  test("model input drops unanswered calls without manufacturing tool results", async () => {
    const threadId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const runner = new LocalAgentRunner(tempDb());
    let seen: { id: string }[] = [];
    const agent = {
      agentId: "coord",
      async runAgent(input, { onEvent }) {
        seen = input.messages;
        onEvent({
          event: { type: EventType.RUN_STARTED, threadId, runId: "r2" },
        });
        onEvent({
          event: { type: EventType.RUN_FINISHED, threadId, runId: "r2" },
        });
      },
      abortRun() {},
    } as unknown as AbstractAgent;
    // What the CopilotKit client resends after a render-only action: the assistant message with
    // its call and nothing answering it. The second call is answered and must be left alone.
    const messages = [
      { id: "u1", role: "user", content: "notice please" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "28c4a590",
            type: "function",
            function: { name: "showNotice", arguments: "{}" },
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c9",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      { id: "t9", role: "tool", toolCallId: "c9", content: "ok" },
      { id: "u2", role: "user", content: "again" },
    ];
    await collect(
      runner.run({
        threadId,
        agent,
        input: {
          threadId,
          runId: "r2",
          messages: messages as never,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
    );
    expect(seen.map((row) => row.id)).toEqual(["u1", "a2", "t9", "u2"]);
    expect(seen[2]).toEqual(messages[3]);
    // Persistence retains the original tool association, not a tool-shaped text row.
    expect(
      runner.getThreadMessages(threadId).find((row) => row.id === "t9"),
    ).toEqual(messages[3]);
    // The helper on its own: an already-answered list comes back unchanged.
    expect(ensureToolResults(messages.slice(2, 4))).toEqual(
      messages.slice(2, 4),
    );
  });

  test("legacy tool links are repaired only from explicit same-message event evidence", () => {
    const path = tempDb();
    const runner = new LocalAgentRunner(path);
    const db = new Database(path);
    const events = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "recovered",
        role: "tool",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "recovered",
        delta: "original evidence",
      },
      { type: EventType.TEXT_MESSAGE_START, messageId: "orphan", role: "tool" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "orphan",
        delta: "unlinked evidence",
      },
      {
        type: EventType.RUN_STARTED,
        input: {
          messages: [
            {
              id: "flat",
              role: "assistant",
              content: "lookup",
              toolCalls: [
                { id: "real-call", name: "lookup", args: { q: "original" } },
              ],
            },
            {
              id: "recovered",
              role: "tool",
              content: "original evidence",
              toolCallId: "real-call",
            },
          ],
        },
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "malformed-result",
        content: "preserve this too",
      },
    ];
    for (const event of events)
      db.run(
        "INSERT INTO thread_events(thread_id, created_at, event) VALUES (?, ?, ?)",
        ["legacy", Date.now(), JSON.stringify(event)],
      );
    expect(runner.getThreadMessages("legacy")).toEqual([
      {
        id: "recovered",
        role: "tool",
        content: "original evidence",
        toolCallId: "real-call",
      },
      { id: "orphan", role: "tool", content: "unlinked evidence" },
      {
        id: "flat",
        role: "assistant",
        content: "lookup",
        toolCalls: [
          {
            id: "real-call",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"original"}' },
          },
        ],
      },
      { id: "malformed-result", role: "tool", content: "preserve this too" },
    ]);
    db.close();
  });

  test("a thread lock left unreleased lapses after its TTL", async () => {
    let clock = 1_000;
    const store = createLocalThreadStore(":memory:", { now: () => clock });
    const input = {
      threadId: "t-lock",
      runId: "r1",
      userId: "u",
      agentId: "coord",
    };
    expect(await store.lock.acquire(input)).toEqual({ runId: "r1" });
    expect(await store.lock.acquire({ ...input, runId: "r2" })).toBeNull();

    // A renew at 119 s pushes the expiry out; 60 s later the original TTL has passed but the
    // renewed one has not.
    clock += 119_000;
    await store.lock.renew({ threadId: "t-lock", runId: "r1" });
    clock += 60_000;
    expect(await store.lock.acquire({ ...input, runId: "r2" })).toBeNull();

    // Never released: past the renewed expiry the thread is free again.
    clock += 120_001;
    expect(await store.lock.acquire({ ...input, runId: "r2" })).toEqual({
      runId: "r2",
    });
  });

  test("fillConnectRequest supplies the fields CopilotKit's schema requires", async () => {
    const filled = await fillConnectRequest(
      new Request("http://127.0.0.1/api/copilotkit/agent/coord/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        }),
      }),
    );
    const body = (await filled.json()) as {
      threadId: string;
      runId: string;
      messages: unknown[];
      tools: unknown[];
      context: unknown[];
    };
    expect(body.threadId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(typeof body.runId).toBe("string");
    expect(body.runId.length).toBeGreaterThan(0);
    expect(body.messages).toEqual([]);
    expect(body.tools).toEqual([]);
    expect(body.context).toEqual([]);
  });
});
