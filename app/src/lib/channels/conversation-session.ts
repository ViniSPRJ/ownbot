/**
 * Whether the last turn was still talking to the same CLI session, said where it matters.
 *
 * The failure this exists for is silent. A conversation whose session was lost reads exactly like one
 * that never lost it: the thread is all there, the answer arrived on time, and the only party that
 * knows the model had never heard of any of it is the CLI. The person then follows up on a detail from
 * four turns ago and gets an answer composed from whatever OwnBot re-sent, not from the work.
 *
 * Restart wording is shown only when something was actually lost or cannot carry across. The
 * CLI-confirmed model of the last session is always said: the picker is next-turn configuration,
 * and treating its catalogue as what answered is the lie this line exists to prevent. The session
 * row is written before the prompt runs, so the wording must not claim a completed answer.
 */

export type ConversationSession = {
  resumed: boolean;
  /**
   * Why a new session was opened, when one was.
   *
   * One of `first_turn`, `load_unsupported`, `anchor_dead`, `provider_changed`, `model_changed`,
   * `record_unreadable`, `requested`, as written by the runtime. An unknown value is treated as a new
   * session with no explanation rather than hidden: the restart happened either way.
   */
  reason: string | null;
  /** Requested selection. Not the id the CLI confirmed; that is `resolvedModel`. */
  model: string | null;
  requestedModel: string | null;
  /**
   * Confirmed effective id from the last turn, or null when the CLI did not report one.
   *
   * Absent on older trail rows, which is the same as unknown: never treat `model` as confirmation.
   */
  resolvedModel: string | null;
  executor: "acp" | null;
  runId: string | null;
  profileId: string | null;
  provider: string;
  /** ISO-8601, from the trail row. */
  at: string;
};

export type SessionNoticeView =
  /** No session row to read. */
  | { kind: "hidden" }
  | {
      kind: "notice";
      text: string;
      /**
       * `attention` is for a session that was lost — something existed and no longer does. `neutral` is
       * for one that could never have carried across, which is a property of the CLI or of a choice the
       * person made, not a fault.
       */
      tone: "attention" | "neutral";
    };

const NOTICES: Record<string, { text: string; tone: "attention" | "neutral" }> =
  {
    anchor_dead: {
      text: "A sessão anterior não existe mais na CLI. Este turno abriu uma nova, com o histórico que o OwnBot reenviou.",
      tone: "attention",
    },
    record_unreadable: {
      text: "O registro da sessão anterior estava ilegível. Este turno abriu uma nova, com o histórico que o OwnBot reenviou.",
      tone: "attention",
    },
    model_changed: {
      text: "A sessão não continua depois de trocar o modelo. Este turno abriu uma nova, com o histórico que o OwnBot reenviou.",
      tone: "neutral",
    },
    provider_changed: {
      text: "A sessão não continua depois de trocar a conexão. Este turno abriu uma nova, com o histórico que o OwnBot reenviou.",
      tone: "neutral",
    },
    load_unsupported: {
      text: "Esta CLI não reabre sessões, então cada turno começa uma nova, com o histórico que o OwnBot reenviou.",
      tone: "neutral",
    },
  };

/**
 * Two reasons are deliberately silent as restarts.
 *
 * `first_turn` is not a restart: there was nothing to continue. `requested` is the person having asked
 * for a new session, and telling somebody what they just did is the kind of notice that teaches people
 * to ignore notices. The last session's confirmed model is still shown.
 */
const SILENT = new Set(["first_turn", "requested"]);

/**
 * The CLI-confirmed model of the last session, or an explicit admission that it did not confirm one.
 *
 * Written before the prompt runs, so this is not a claim that an answer completed. `model` /
 * `requestedModel` are the selection that was asked for, including on older rows that stored only
 * that. They are not evidence of what the CLI confirmed.
 */
export function sessionModelLine(session: ConversationSession): string {
  const resolved = session.resolvedModel;
  if (typeof resolved === "string" && resolved.length > 0) {
    return `Modelo confirmado pela CLI na última sessão: ${resolved}.`;
  }
  return "Modelo não confirmado pela CLI.";
}

/**
 * Hover detail for known session provenance only. Missing executor, profile or run stay off.
 * A null requested selection is the operator default, not a guessed machine.
 */
export function sessionNoticeTitle(session: ConversationSession): string {
  const parts: string[] = [];
  const requested = session.requestedModel ?? session.model;
  parts.push(
    typeof requested === "string" && requested.length > 0
      ? `solicitado ${requested}`
      : "padrão",
  );
  if (session.executor === "acp") parts.push("executor acp");
  if (typeof session.profileId === "string" && session.profileId.length > 0) {
    parts.push(`perfil ${session.profileId}`);
  }
  if (typeof session.runId === "string" && session.runId.length > 0) {
    parts.push(`run ${session.runId}`);
  }
  return parts.join(" · ");
}

export function sessionNoticeView(
  session: ConversationSession | null | undefined,
): SessionNoticeView {
  if (!session) return { kind: "hidden" };
  const modelLine = sessionModelLine(session);
  if (session.resumed) {
    return { kind: "notice", text: modelLine, tone: "neutral" };
  }
  const reason = session.reason ?? "";
  if (SILENT.has(reason)) {
    return { kind: "notice", text: modelLine, tone: "neutral" };
  }
  const known = NOTICES[reason];
  if (known) {
    return {
      kind: "notice",
      text: `${known.text} ${modelLine}`,
      tone: known.tone,
    };
  }
  // A new session with a reason this build does not recognise. Still reported: a restart nobody can
  // name is a restart, and the quiet version of this is the bug the whole row exists to catch.
  return {
    kind: "notice",
    text: `Este turno abriu uma sessão nova, com o histórico que o OwnBot reenviou. ${modelLine}`,
    tone: "attention",
  };
}
