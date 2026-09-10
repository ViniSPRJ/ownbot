import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { mergeThreadHistory } from "./merge-history";

const message = (id: string, content = id): Message => ({
  id,
  role: "assistant",
  content,
});

describe("history restoration during reconnect and handoff", () => {
  test("repairs misplaced old history and a truncated cancellation before a worker callback", () => {
    const stored = [
      message("question"),
      message("cancelled", "1\n2\n3\n"),
      message("delegate"),
      message("queued"),
      message("completed"),
    ];
    const live = [
      message("delegate"),
      message("queued"),
      message("question"),
      message("cancelled", "1\n2"),
    ];
    const original = structuredClone(live);
    const merged = mergeThreadHistory(stored, live);
    expect(merged).toEqual(stored);
    expect(live).toEqual(original);
    expect(mergeThreadHistory(stored, merged)).toBe(merged);
  });

  test("a stale read never shortens a currently streaming answer or removes a new user turn", () => {
    const live = [
      message("answer", "hello world"),
      { id: "new", role: "user", content: "continue" } as Message,
    ];
    expect(mergeThreadHistory([message("answer", "hello")], live)).toBe(live);
    expect(mergeThreadHistory([], live)).toBe(live);
  });

  test("local-only tool rows retain their anchor inside restored history", () => {
    const live = [
      message("start"),
      message("call"),
      {
        id: "result",
        role: "tool",
        toolCallId: "tool1",
        content: "42",
      } as Message,
      message("end"),
    ];
    expect(
      mergeThreadHistory(
        [message("old"), message("start"), message("end"), message("callback")],
        live,
      ).map((m) => m.id),
    ).toEqual(["old", "start", "call", "result", "end", "callback"]);
  });

  test("preserves streamed tool arguments and calls while completing stored content", () => {
    const call = (id: string, args: string) => ({
      id,
      type: "function" as const,
      function: { name: "lookup", arguments: args },
    });
    const live: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: "Read",
        toolCalls: [call("c", '{"x":1}'), call("d", "{}")],
      },
    ];
    const stored: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: "Read this",
        toolCalls: [call("c", '{"x":')],
      },
    ];
    expect(mergeThreadHistory(stored, live)[0]).toEqual({
      id: "a",
      role: "assistant",
      content: "Read this",
      toolCalls: [call("c", '{"x":1}'), call("d", "{}")],
    });
  });

  test("deduplicates repeated snapshots and favors durable non-prefix corrections", () => {
    expect(
      mergeThreadHistory(
        [message("a", "corrected"), message("a", "corrected")],
        [message("a", "obsolete"), message("a", "obsolete")],
      ),
    ).toEqual([message("a", "corrected")]);
  });
});
