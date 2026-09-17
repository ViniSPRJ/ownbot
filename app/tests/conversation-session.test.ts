import { describe, expect, test } from "bun:test";
import {
  type ConversationSession,
  sessionNoticeTitle,
  sessionNoticeView,
} from "@/lib/channels/conversation-session";

const session = (
  over: Partial<ConversationSession> = {},
): ConversationSession => ({
  resumed: false,
  reason: "anchor_dead",
  model: "gpt-5.1",
  requestedModel: "gpt-5.1",
  resolvedModel: "gpt-5.1",
  executor: "acp",
  runId: "run-1",
  profileId: "codex",
  provider: "codex",
  at: "2026-09-12T17:54:00.000Z",
  ...over,
});

describe("telling somebody their session did not carry over", () => {
  test("no session row is still nothing at all", () => {
    expect(sessionNoticeView(null)).toEqual({ kind: "hidden" });
    expect(sessionNoticeView(undefined)).toEqual({ kind: "hidden" });
  });

  test("an ordinary turn names the confirmed model and is not a restart", () => {
    const view = sessionNoticeView(session({ resumed: true }));
    expect(view).toEqual({
      kind: "notice",
      text: "Modelo confirmado pela CLI na última sessão: gpt-5.1.",
      tone: "neutral",
    });
  });

  test("a first turn is not a restart, and still names the confirmed model", () => {
    const view = sessionNoticeView(session({ reason: "first_turn" }));
    expect(view).toEqual({
      kind: "notice",
      text: "Modelo confirmado pela CLI na última sessão: gpt-5.1.",
      tone: "neutral",
    });
  });

  test("a restart the person asked for is not news as a restart", () => {
    const view = sessionNoticeView(session({ reason: "requested" }));
    expect(view).toEqual({
      kind: "notice",
      text: "Modelo confirmado pela CLI na última sessão: gpt-5.1.",
      tone: "neutral",
    });
  });

  test("a lost session asks for attention, and says the history was re-sent", () => {
    for (const reason of ["anchor_dead", "record_unreadable"]) {
      const view = sessionNoticeView(session({ reason }));
      expect(view.kind).toBe("notice");
      if (view.kind !== "notice") return;
      expect(view.tone).toBe("attention");
      expect(view.text).toContain("ownbot reenviou");
      expect(view.text).toContain(
        "Modelo confirmado pela CLI na última sessão: gpt-5.1.",
      );
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
      expect(view.text).toContain(
        "Modelo confirmado pela CLI na última sessão: gpt-5.1.",
      );
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
      expect(view.text).toContain("sessão nova");
    }
  });

  test("an unconfirmed last turn is said, never filled in from the requested selection", () => {
    const view = sessionNoticeView(
      session({
        resumed: true,
        model: "gpt-5.1",
        requestedModel: "gpt-5.1",
        resolvedModel: null,
      }),
    );
    expect(view).toEqual({
      kind: "notice",
      text: "Modelo não confirmado pela CLI.",
      tone: "neutral",
    });
  });

  test("older audit rows stay honest: a legacy model is requested, not confirmed", () => {
    const view = sessionNoticeView(
      session({
        resumed: true,
        model: "gpt-5.1",
        requestedModel: "gpt-5.1",
        resolvedModel: null,
        executor: null,
        runId: null,
        profileId: null,
      }),
    );
    expect(view.kind).toBe("notice");
    if (view.kind !== "notice") return;
    expect(view.text).toBe("Modelo não confirmado pela CLI.");
    expect(view.text).not.toContain("gpt-5.1");
  });

  test("the hover title names only known requested, executor, profile and run", () => {
    expect(sessionNoticeTitle(session())).toBe(
      "solicitado gpt-5.1 · executor acp · perfil codex · run run-1",
    );
    expect(
      sessionNoticeTitle(
        session({
          requestedModel: null,
          model: null,
          executor: null,
          profileId: null,
          runId: null,
        }),
      ),
    ).toBe("padrão");
  });
});
