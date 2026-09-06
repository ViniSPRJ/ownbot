import { expect, test } from "bun:test";
import { INCOMPLETE_HISTORY_MARKER } from "../../../../shared/history-markers";
import { toVisibleChatItems } from "./chat-messages";

test("large incomplete history stays a separate collapsible record with full raw payload", () => {
  const payload = JSON.stringify({ text: "saved ".repeat(10000), url: "[click](https://example.invalid)", html: "<script>not markup</script>" });
  const items = toVisibleChatItems([
    { id: "old", role: "assistant", content: `${INCOMPLETE_HISTORY_MARKER}${payload}` },
    { id: "answer", role: "assistant", content: "Resposta normal" },
  ]);
  expect(items).toEqual([
    { kind: "incomplete-history", id: "old", payload },
    { kind: "text", id: "answer", role: "assistant", text: "Resposta normal" },
  ]);
  expect(toVisibleChatItems([{ id: "empty", role: "assistant", content: INCOMPLETE_HISTORY_MARKER }])[0]?.kind).toBe("incomplete-history");
});
