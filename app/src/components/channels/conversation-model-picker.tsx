import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ConversationModelState,
  canSubmit,
  modelPickerView,
  pickerDraftState,
} from "@/lib/channels/conversation-model";
import { client } from "@/lib/client";

/**
 * Which model this conversation is configured to use on the next turn.
 *
 * Sits in the conversation rather than in the coworker's settings page on purpose: the administrator
 * sets what a role uses by default over there, and a person changes what this thread will use here.
 * The catalogue is not a confirmed record of what last answered; that lives on the session note.
 *
 * Renders nothing when the coworker is not on an ACP connection. An empty dropdown next to a coworker
 * that has no CLI is not a reduced control; it is a lie about what can be chosen.
 */
export function ConversationModelPicker({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const key = ["conversations", "acp-model", threadId, agentId] as const;
  const path = `/api/conversations/${encodeURIComponent(threadId)}/acp-model/${encodeURIComponent(agentId)}`;
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      client<ConversationModelState>(path, "selection", {
        fallback: "Could not load this coworker's models.",
      }),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (model: string | null) =>
      client(path, {
        method: "PUT",
        body: { model, revision: query.data?.revision },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ["conversations", "acp-model", threadId],
      });
    },
    onError: () => {
      // The server refused, most often because the operator's catalogue moved underneath the list. The
      // list is the thing that is now wrong, so it is the thing that gets refetched.
      setDraft(undefined);
      void query.refetch();
    },
  });
  const view = modelPickerView(query.data);
  if (view.kind !== "picker") return null;
  const selection = pickerDraftState({ draft, current: view.value });
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2">
      <label
        className="text-xs text-muted-foreground"
        htmlFor={`acp-model-${threadId}`}
      >
        Model
      </label>
      <select
        id={`acp-model-${threadId}`}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        value={selection.value}
        disabled={view.readOnly || save.isPending}
        onChange={(event) => {
          setSaved(false);
          // Empty string is Default on purpose. `undefined` is "not touched", and mapping Default
          // onto that made the control look unchanged so the save never went out.
          setDraft(event.target.value);
        }}
      >
        <option value="">Default</option>
        {view.options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      {selection.dirty || save.isPending ? (
        <Button
          size="sm"
          variant="outline"
          disabled={
            !canSubmit({
              revision: query.data?.revision,
              readOnly: view.readOnly,
              dirty: selection.dirty,
              pending: save.isPending,
            })
          }
          onClick={() => void save.mutate(selection.modelToSave)}
        >
          Save
        </Button>
      ) : null}
      {/* Three things the person is entitled to read here, and only one of them is about a choice. */}
      {save.isError ? (
        <span className="text-xs text-destructive" role="alert">
          {save.error?.message ?? "Could not save that choice."}
        </span>
      ) : saved ? (
        <span className="text-xs text-muted-foreground" role="status">
          Saved. It applies from the next turn.
        </span>
      ) : view.note ? (
        <span className="text-xs text-muted-foreground" role="status">
          {view.note}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground" role="status">
          Next turn uses {view.answering}.
        </span>
      )}
    </div>
  );
}
