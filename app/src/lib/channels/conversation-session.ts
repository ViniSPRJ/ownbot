/**
 * Whether the last turn was still talking to the same CLI session, said where it matters.
 *
 * The failure this exists for is silent. A conversation whose session was lost reads exactly like one
 * that never lost it: the thread is all there, the answer arrived on time, and the only party that
 * knows the model had never heard of any of it is the CLI. The person then follows up on a detail from
 * four turns ago and gets an answer composed from whatever ownbot re-sent, not from the work.
 *
 * So the note is shown only when something was actually lost or cannot carry across, and is silent on
 * every ordinary turn. A banner that appears on all of them is a banner nobody reads on the one that
 * mattered.
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
  model: string | null;
  provider: string;
  /** ISO-8601, from the trail row. */
  at: string;
};

export type SessionNoticeView =
  /** An ordinary turn: the session continued, or this is the first one. */
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
      text: "A sessão anterior não existe mais na CLI. Este turno abriu uma nova, com o histórico que o ownbot reenviou.",
      tone: "attention",
    },
    record_unreadable: {
      text: "O registro da sessão anterior estava ilegível. Este turno abriu uma nova, com o histórico que o ownbot reenviou.",
      tone: "attention",
    },
    model_changed: {
      text: "A sessão não continua depois de trocar o modelo. Este turno abriu uma nova, com o histórico que o ownbot reenviou.",
      tone: "neutral",
    },
    provider_changed: {
      text: "A sessão não continua depois de trocar a conexão. Este turno abriu uma nova, com o histórico que o ownbot reenviou.",
      tone: "neutral",
    },
    load_unsupported: {
      text: "Esta CLI não reabre sessões, então cada turno começa uma nova, com o histórico que o ownbot reenviou.",
      tone: "neutral",
    },
  };

/**
 * Two reasons are deliberately silent.
 *
 * `first_turn` is not a restart: there was nothing to continue. `requested` is the person having asked
 * for a new session, and telling somebody what they just did is the kind of notice that teaches people
 * to ignore notices.
 */
const SILENT = new Set(["first_turn", "requested"]);

export function sessionNoticeView(
  session: ConversationSession | null | undefined,
): SessionNoticeView {
  if (!session) return { kind: "hidden" };
  if (session.resumed) return { kind: "hidden" };
  const reason = session.reason ?? "";
  if (SILENT.has(reason)) return { kind: "hidden" };
  const known = NOTICES[reason];
  if (known) return { kind: "notice", ...known };
  // A new session with a reason this build does not recognise. Still reported: a restart nobody can
  // name is a restart, and the quiet version of this is the bug the whole row exists to catch.
  return {
    kind: "notice",
    text: "Este turno abriu uma sessão nova, com o histórico que o ownbot reenviou.",
    tone: "attention",
  };
}
