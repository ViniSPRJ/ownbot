/** Compatibility marker for display-only records projected from unassociated historical results. */
export const INCOMPLETE_HISTORY_MARKER =
  "[Incomplete tool history: original tool result could not be associated with a recorded call; this is not a verified assistant conclusion.]\n\n";

export function incompleteHistoryPayload(message: { role?: string; content?: unknown }): string | undefined {
  return message.role === "assistant" && typeof message.content === "string" &&
    message.content.startsWith(INCOMPLETE_HISTORY_MARKER)
    ? message.content.slice(INCOMPLETE_HISTORY_MARKER.length)
    : undefined;
}
