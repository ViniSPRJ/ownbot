import type { Message } from "@ag-ui/core";

// A durable read can lag a stream, and a reconnect snapshot can lag durable history.
// Keep the longer prefix in either direction; unrelated revisions favor the durable read.
function completeText(stored: string, live: string): string {
  return live.startsWith(stored) ? live : stored;
}

function completeMessage(stored: Message, live: Message | undefined): Message {
  if (!live || live.role !== stored.role) return stored;
  const merged = { ...live, ...stored } as Message;
  if (typeof stored.content === "string" && typeof live.content === "string") {
    merged.content = completeText(stored.content, live.content);
  }
  if (
    merged.role === "assistant" &&
    live.role === "assistant" &&
    stored.role === "assistant"
  ) {
    const calls = new Map(
      (live.toolCalls ?? []).map((call) => [call.id, call]),
    );
    for (const call of stored.toolCalls ?? []) {
      const prior = calls.get(call.id);
      calls.set(
        call.id,
        prior
          ? {
              ...prior,
              ...call,
              function: {
                ...prior.function,
                ...call.function,
                arguments: completeText(
                  call.function.arguments,
                  prior.function.arguments,
                ),
              },
            }
          : call,
      );
    }
    if (calls.size) merged.toolCalls = [...calls.values()];
  }
  // Avoid rendering again when a retried read adds nothing.
  return JSON.stringify(merged) === JSON.stringify(live) ? live : merged;
}

/** Restore canonical stored order while retaining live turns and complete streamed content. */
export function mergeThreadHistory(
  stored: readonly Message[],
  live: Message[],
): Message[] {
  const durable = new Map(stored.map((message) => [message.id, message]));
  const current = new Map(live.map((message) => [message.id, message]));
  const before = new Map<string, Message[]>();
  let pending: Message[] = [];
  const seen = new Set<string>();
  for (const message of live) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    if (durable.has(message.id)) {
      before.set(message.id, pending);
      pending = [];
    } else {
      pending.push(message);
    }
  }
  const merged = [...durable.values()].flatMap((message) => [
    ...(before.get(message.id) ?? []),
    completeMessage(message, current.get(message.id)),
  ]);
  merged.push(...pending);
  return merged.length === live.length &&
    merged.every((message, i) => message === live[i])
    ? live
    : merged;
}
