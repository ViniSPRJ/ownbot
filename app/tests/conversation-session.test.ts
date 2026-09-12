import { describe, expect, test } from "bun:test";
import {
  type ConversationSession,
  sessionNoticeView,
} from "@/lib/channels/conversation-session";

const session = (over: Partial<ConversationSession> = {}): ConversationSession => ({
  resumed: false,
  reason: "anchor_dead",
  model: "gpt-5.1",
  provider: "codex",
  at: "2026-09-12T17:54:00.000Z",
  ...over,
});

describe("telling somebody their session did not carry over", () => {
  test("an ordinary turn says nothing at all", () => {
    // A notice on every turn is a notice nobody reads on the turn that mattered.
    expect(sessionNoticeView(session({ resumed: true }))).toEqual({
      kind: "hidden",
    });
    expect(sessionNoticeView(null)).toEqual({ kind: "hidden" });
    expect(sessionNoticeView(undefined)).toEqual({ kind: "hidden" });
  });

  test("a first turn is not a restart", () => {
    expect(sessionNoticeView(session({ reason: "first_turn" }))).toEqual({
      kind: "hidden",
    });
  });

  test("a restart the person asked for is not news to them", () => {
    expect(sessionNoticeView(session({ reason: "requested" }))).toEqual({
      kind: "hidden",
    });
  });

  test("a lost session asks for attention, and says the history was re-sent", () => {
    for (const reason of ["anchor_dead", "record_unreadable"]) {
      const view = sessionNoticeView(session({ reason }));
      expect(view.kind).toBe("notice");
      if (view.kind !== "notice") return;
      expect(view.tone).toBe("attention");
      expect(view.text).toContain("ownbot reenviou");
    }
  });

  test("a session that could never have carried across is stated, not flagged", () => {
    // Changing the model, changing the connection, or a CLI that cannot reopen a session are
    // properties of the setup or of a deliberate choice. Colouring those like a fault teaches people
    // that the colour means nothing.
    for (const reason of [
      "model_changed",
      "provider_changed",
      "load_unsupported",
    ]) {
      const view = sessionNoticeView(session({ reason }));
      expect(view.kind).toBe("notice");
      if (view.kind !== "notice") return;
      expect(view.tone).toBe("neutral");
    }
  });

  test("a restart this build cannot name is still reported", () => {
    // The quiet version of this is the exact bug the row exists to catch, so an unknown reason errs
    // towards saying something.
    for (const reason of ["something_new", null]) {
      const view = sessionNoticeView(session({ reason }));
      expect(view.kind).toBe("notice");
      if (view.kind !== "notice") return;
      expect(view.tone).toBe("attention");
    }
  });
});
