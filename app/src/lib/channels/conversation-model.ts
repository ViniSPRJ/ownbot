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
  /**
   * What the CLI catalogue currently advertises as selected.
   *
   * Configuration for the next turn, not a confirmed record of what last answered. That
   * confirmation lives on the session note, from the trail.
   */
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
      /** The person's explicit choice, or undefined when following the operator default. */
      value: string | undefined;
      options: { id: string; name: string }[];
      /** Read-only because this person may read but not choose. */
      readOnly: boolean;
      /**
       * Shown when a stored choice is no longer the one that will run next.
       *
       * Wording is about the next turn's configuration, not about what last answered. The catalogue
       * is not a confirmed session model.
       */
      note: string | null;
      /** The option label for the model configured for the next turn. */
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
  const configured =
    state.selected ?? state.operatorDefault ?? state.currentModel;
  return {
    kind: "picker",
    // Only a standing per-conversation choice is pinned in the control. Following the operator
    // default must read as Default, not as the CLI catalogue's current id.
    value: state.selected ?? undefined,
    options: state.models,
    readOnly: !state.canSelect,
    // Only says something when a choice existed and is no longer the one configured. A first turn
    // with no choice is not a dropped choice.
    note:
      state.dropped && state.dropped !== null
        ? state.dropped === "stale"
          ? `Your earlier choice no longer applies to this coworker. Next turn uses ${nameOf(state.models, configured)}.`
          : `This coworker is on a different connection now, so your earlier choice does not carry over. Next turn uses ${nameOf(state.models, configured)}.`
        : null,
    answering: nameOf(state.models, configured),
  };
}

/**
 * Draft vs current value for the conversation model picker.
 *
 * Empty string is a deliberate Default. `undefined` means the control has not been touched, and
 * must not be treated as Default: that was the bug that made Default look unsaved and unsavable.
 */
export function pickerDraftState(input: {
  draft: string | undefined;
  current: string | undefined;
}): { value: string; dirty: boolean; modelToSave: string | null } {
  const current = input.current ?? "";
  return {
    value: input.draft ?? current,
    dirty: input.draft !== undefined && input.draft !== current,
    modelToSave: input.draft === "" ? null : (input.draft ?? null),
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
