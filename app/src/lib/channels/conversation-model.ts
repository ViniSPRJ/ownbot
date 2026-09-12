/**
 * What the conversation's model picker shows, decided outside the component.
 *
 * The interesting part of this control is not the dropdown. It is refusing to imply a choice the
 * runtime is not honouring. A picker that reads back the model the person last clicked, while the
 * runtime answers on the operator's default because the operator replaced the catalogue an hour ago,
 * tells the person something about their conversation that is not true — and the only evidence to the
 * contrary is in a table they are not looking at.
 */

export type ConversationModelState = {
  models: { id: string; name: string }[];
  /** What the session is answering with right now. */
  currentModel: string | null;
  /** The operator's default for this coworker's connection. */
  operatorDefault: string | null;
  /** The person's own choice, only while it is still admissible. */
  selected: string | null;
  /** Why `selected` was dropped, when it was. */
  dropped: "stale" | "connection_changed" | null;
  revision: string;
  canSelect: boolean;
};

export type ModelPickerView =
  /** Nothing to show: no ACP connection, no catalogue, or no room to choose in. */
  | { kind: "hidden" }
  /** The CLI is unreachable. Said, rather than shown as an empty list. */
  | { kind: "unavailable"; message: string }
  | {
      kind: "picker";
      /** What the control reads. The person's choice if it holds, otherwise what is running. */
      value: string | undefined;
      options: { id: string; name: string }[];
      /** Read-only because this person may read but not choose. */
      readOnly: boolean;
      /**
       * Shown when what is running is not what was last picked.
       *
       * Wording is deliberately plain: this is not an error and not a warning. The turn answered. It
       * answered on a different model, and the person is entitled to know which one they are reading.
       */
      note: string | null;
      /** The option label for the model actually answering. */
      answering: string;
    };

const DEFAULT_TEXT = "the coworker's default";

function nameOf(
  models: ConversationModelState["models"],
  id: string | null,
): string {
  if (!id) return DEFAULT_TEXT;
  return models.find((model) => model.id === id)?.name ?? id;
}

export function modelPickerView(
  state: ConversationModelState | undefined,
): ModelPickerView {
  if (!state) return { kind: "hidden" };
  if (state.models.length === 0) return { kind: "hidden" };
  const answering =
    state.selected ?? state.currentModel ?? state.operatorDefault;
  return {
    kind: "picker",
    value: state.selected ?? state.currentModel ?? undefined,
    options: state.models,
    readOnly: !state.canSelect,
    // Only says something when a choice existed and is no longer the one running. A first turn with no
    // choice is not a dropped choice, and saying "your choice no longer applies" there would be a lie.
    note:
      state.dropped && state.dropped !== null
        ? state.dropped === "stale"
          ? `Your earlier choice no longer applies to this coworker. This is answering with ${nameOf(state.models, answering)}.`
          : `This coworker is on a different connection now, so your earlier choice does not carry over. This is answering with ${nameOf(state.models, answering)}.`
        : null,
    answering: nameOf(state.models, answering),
  };
}

/**
 * Whether a pick may be sent.
 *
 * The revision travels with every write and the server compares it, so a stale list cannot overwrite a
 * newer choice. Nothing here makes that safe by guessing: an absent revision is a refusal.
 */
export function canSubmit(input: {
  revision: string | undefined;
  readOnly: boolean;
  dirty: boolean;
  pending: boolean;
}): boolean {
  return (
    !input.readOnly &&
    input.dirty &&
    !input.pending &&
    typeof input.revision === "string" &&
    input.revision.length > 0
  );
}
