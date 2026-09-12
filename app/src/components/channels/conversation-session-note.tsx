import { useQuery } from "@tanstack/react-query";
import {
  type ConversationSession,
  sessionNoticeView,
} from "@/lib/channels/conversation-session";
import { client } from "@/lib/client";

/**
 * What the last turn did with this coworker's CLI session.
 *
 * Beside the transcript, because that is where somebody is when the question occurs to them. The fact
 * is also in the audit trail, which answers it for an administrator afterwards; this answers it for the
 * person who is about to follow up on something the model may no longer be holding.
 *
 * Renders nothing on an ordinary turn, nothing on a first turn, and nothing for a coworker that has no
 * ACP connection — the endpoint refuses those, and a refusal is not a notice.
 */
export function ConversationSessionNote({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}) {
  const query = useQuery({
    queryKey: ["conversations", "acp-session", threadId, agentId] as const,
    queryFn: () =>
      client<ConversationSession | null>(
        `/api/conversations/${encodeURIComponent(threadId)}/acp-session/${encodeURIComponent(agentId)}`,
        "session",
        { fallback: "Could not read this conversation's session." },
      ),
    retry: false,
    /*
     * Re-read when the window comes back, unlike the model picker.
     *
     * The model is what this person last chose and changes when they change it. This is the outcome of
     * the last turn, and the turn they are waiting on may have finished while they were in another tab.
     */
    staleTime: 10_000,
  });
  const view = sessionNoticeView(query.data ?? null);
  if (view.kind !== "notice") return null;
  return (
    <p
      className={`pb-2 text-xs ${view.tone === "attention" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
      role="status"
    >
      {view.text}
    </p>
  );
}
