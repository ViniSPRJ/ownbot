import { useQuery } from "@tanstack/react-query";
import {
  type ConversationSession,
  sessionNoticeTitle,
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
 * Renders nothing when there is no session row. When there is one, it names the model the CLI
 * confirmed on the last session, or says it did not confirm one. Restart wording is added only when
 * the session did not carry across. A coworker with no ACP connection is refused by the endpoint,
 * and a refusal is not a notice.
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
     * Re-read on an interval while this tab is visible, and when the window comes back.
     *
     * The picker is what this person last chose. This is the last session the CLI confirmed, written
     * before the prompt, and a turn in flight in this tab should be able to surface it without a
     * focus change. Background tabs stay quiet.
     */
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const session = query.data ?? null;
  const view = sessionNoticeView(session);
  if (view.kind !== "notice") return null;
  return (
    <p
      className={`pb-2 text-xs ${view.tone === "attention" ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"}`}
      role="status"
      title={session ? sessionNoticeTitle(session) : undefined}
    >
      {view.text}
    </p>
  );
}
