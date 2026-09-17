import { describe, expect, test } from "bun:test";
import {
  type ConversationModelState,
  canSubmit,
  modelPickerView,
  pickerDraftState,
} from "@/lib/channels/conversation-model";

const state = (
  over: Partial<ConversationModelState> = {},
): ConversationModelState => ({
  models: [
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "gpt-5.1", name: "GPT-5.1" },
  ],
  currentModel: "gpt-5.1-codex",
  operatorDefault: "gpt-5.1-codex",
  selected: null,
  dropped: null,
  revision: "rev-1",
  canSelect: true,
  ...over,
});

describe("the conversation model picker", () => {
  test("a coworker with no advertised models shows no control at all", () => {
    // An empty dropdown beside a coworker that has no CLI is not a smaller control. It is a claim
    // that something can be chosen when nothing can.
    expect(modelPickerView(state({ models: [] }))).toEqual({ kind: "hidden" });
    expect(modelPickerView(undefined)).toEqual({ kind: "hidden" });
  });

  test("with no choice made, the control reads Default and names the operator's next-turn model", () => {
    const view = modelPickerView(state());
    expect(view.kind).toBe("picker");
    if (view.kind !== "picker") return;
    expect(view.value).toBeUndefined();
    // Nothing was dropped, so nothing may be reported as dropped.
    expect(view.note).toBeNull();
    expect(view.answering).toBe("GPT-5.1 Codex");
  });

  test("a person's standing choice reads back as theirs", () => {
    const view = modelPickerView(state({ selected: "gpt-5.1" }));
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.value).toBe("gpt-5.1");
    expect(view.note).toBeNull();
    expect(view.answering).toBe("GPT-5.1");
  });

  test("a stale choice says what the next turn uses, not that the last turn answered with it", () => {
    const view = modelPickerView(
      state({ selected: null, currentModel: "gpt-5.1", dropped: "stale" }),
    );
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.note).toContain("no longer applies");
    expect(view.note).toContain("Next turn uses GPT-5.1 Codex");
    expect(view.note).not.toContain("answering");
  });

  test("the operator default precedes the CLI catalogue, and Default is not a pinned catalogue id", () => {
    const view = modelPickerView(
      state({
        selected: null,
        operatorDefault: "gpt-5.1",
        currentModel: "gpt-5.1-codex",
      }),
    );
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.value).toBeUndefined();
    expect(view.answering).toBe("GPT-5.1");
  });

  test("resetting to default follows the operator override, not the catalogue current", () => {
    const pinned = modelPickerView(state({ selected: "gpt-5.1-codex" }));
    if (pinned.kind !== "picker") throw new Error("expected a picker");
    expect(pinned.value).toBe("gpt-5.1-codex");
    const reset = modelPickerView(
      state({
        selected: null,
        operatorDefault: "gpt-5.1",
        currentModel: "gpt-5.1-codex",
      }),
    );
    if (reset.kind !== "picker") throw new Error("expected a picker");
    expect(reset.value).toBeUndefined();
    expect(reset.answering).toBe("GPT-5.1");
    expect(pickerDraftState({ draft: "", current: reset.value })).toEqual({
      value: "",
      dirty: false,
      modelToSave: null,
    });
  });

  test("a changed connection says so in its own words", () => {
    const view = modelPickerView(state({ dropped: "connection_changed" }));
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.note).toContain("different connection");
  });

  test("a coworker the person may read but not choose is read-only, and still names its model", () => {
    const view = modelPickerView(state({ canSelect: false }));
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.readOnly).toBe(true);
    expect(view.answering).toBe("GPT-5.1 Codex");
  });

  test("an unknown model id is shown as its id rather than as a friendly nothing", () => {
    const view = modelPickerView(
      state({ selected: "gpt-4-vintage", dropped: null }),
    );
    if (view.kind !== "picker") throw new Error("expected a picker");
    expect(view.answering).toBe("gpt-4-vintage");
  });
});

describe("sending a choice", () => {
  const base = { readOnly: false, dirty: true, pending: false };

  test("an unsaved change with the live revision may go", () => {
    expect(canSubmit({ ...base, revision: "rev-1" })).toBe(true);
  });

  test("nothing goes without the revision the list was read with", () => {
    // The server compares it. An empty one is not "unchanged", it is "unknown".
    expect(canSubmit({ ...base, revision: "" })).toBe(false);
    expect(canSubmit({ ...base, revision: undefined })).toBe(false);
  });

  test("a read-only picker and a send already in flight cannot send", () => {
    expect(canSubmit({ ...base, revision: "rev-1", readOnly: true })).toBe(
      false,
    );
    expect(canSubmit({ ...base, revision: "rev-1", pending: true })).toBe(
      false,
    );
  });

  test("an untouched control has nothing to save", () => {
    expect(canSubmit({ ...base, revision: "rev-1", dirty: false })).toBe(false);
  });
});

describe("the Default draft is a real choice", () => {
  test("an untouched control stays on the current value and is not dirty", () => {
    expect(pickerDraftState({ draft: undefined, current: "gpt-5.1" })).toEqual({
      value: "gpt-5.1",
      dirty: false,
      modelToSave: null,
    });
  });

  test("selecting Default is an empty-string draft that saves null", () => {
    expect(pickerDraftState({ draft: "", current: "gpt-5.1" })).toEqual({
      value: "",
      dirty: true,
      modelToSave: null,
    });
  });

  test("selecting a listed model saves that id", () => {
    expect(
      pickerDraftState({ draft: "gpt-5.1", current: "gpt-5.1-codex" }),
    ).toEqual({
      value: "gpt-5.1",
      dirty: true,
      modelToSave: "gpt-5.1",
    });
  });
});
