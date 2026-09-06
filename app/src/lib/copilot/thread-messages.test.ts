import { describe, expect, test } from "bun:test";
import { readableTurns } from "./thread-messages";

describe("tool history projection", () => {
  test("orphan evidence is visible and labeled without inventing associations", () => {
    const rows = [
      {
        id: "a",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c", name: "lookup", args: {} }],
      },
      { id: "r", role: "tool", toolCallId: "c", content: "valid evidence" },
      {
        id: "lost",
        role: "tool",
        content: "https://source.example/report full evidence",
      },
      {
        id: "unknown",
        role: "tool",
        toolCallId: "missing-call",
        content: "other result",
      },
    ];
    const snapshot = structuredClone(rows);
    const stored = readableTurns(rows);
    expect(stored.unreadable).toBe(0);
    expect(stored.messages).toHaveLength(4);
    expect(stored.messages[1] as unknown).toEqual(rows[1]);
    expect(stored.messages[2]?.role).toBe("assistant");
    expect(stored.messages[2]?.content).toContain("Incomplete tool history");
    expect(stored.messages[2]?.content).toContain(
      "https://source.example/report full evidence",
    );
    expect(stored.messages[2]).not.toHaveProperty("toolCallId");
    expect(stored.messages[3]?.content).toContain("other result");
    expect(rows).toEqual(snapshot);
  });
});
