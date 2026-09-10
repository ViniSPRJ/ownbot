/**
 * Which of ownbot's own failure points an ACP run reached, as one word from a fixed set.
 *
 * Every ACP failure reaches the person as the same sentence, and the log line carried only the
 * phase, so an expired CLI login, a duplicated tool name and an unsupported protocol version were
 * indistinguishable after the fact. The phase says how far the run got; this says what stopped it.
 *
 * The CLI's own output is deliberately not the input. Its stderr and its error strings carry prompt
 * text, page content, file paths and whatever a credential helper printed, none of which belongs in
 * a log line. What is safe to record is which of *our* guards fired, so the classification matches
 * only messages this codebase itself throws, and everything else — including every message that
 * originated in the CLI — is `unknown`. Nothing derived from the error text is ever returned.
 */
export type AcpFailureCause =
  | "busy"
  | "tool_catalogue"
  | "protocol"
  | "mcp_http"
  | "session"
  | "transport"
  | "cli_turn"
  | "no_final_message"
  | "unknown";

/** Exact messages, because a substring test would start matching text we did not write. */
const OWN_MESSAGES = new Map<string, AcpFailureCause>([
  ["Este agente já está trabalhando nesta conversa.", "busy"],
  ["Duplicate ACP tool name", "tool_catalogue"],
  ["Versão ACP não suportada", "protocol"],
  [
    "Este agente ACP não oferece MCP HTTP para as ferramentas do ownbot.",
    "mcp_http",
  ],
  ["Agente ACP não retornou uma sessão", "session"],
  ["A CLI não concluiu o turno.", "cli_turn"],
  [
    "A CLI terminou sem retornar uma resposta final após as ferramentas.",
    "no_final_message",
  ],
]);

/**
 * The transport's failures, which are already sanitised at the point they are raised.
 *
 * `transport.ts` never puts CLI output in an `Error`: every message there is a fixed English string
 * it wrote itself. Matching the family by prefix keeps this classification working when one is
 * added, and the message is still not what gets logged.
 */
const TRANSPORT =
  /^(ACP |Invalid ACP |Invalid message$|Invalid request id$|Invalid response$|Invalid error$|Unsupported ACP client operation$)/;

export function acpFailureCause(error: unknown): AcpFailureCause {
  if (!(error instanceof Error)) return "unknown";
  return (
    OWN_MESSAGES.get(error.message) ??
    (TRANSPORT.test(error.message) ? "transport" : "unknown")
  );
}
