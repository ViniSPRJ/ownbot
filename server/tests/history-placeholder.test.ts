import { expect, test } from "bun:test";
import { INCOMPLETE_HISTORY_MARKER } from "../../shared/history-markers";
import { sanitizeSeededHistory } from "../src/routines/run-turn";

test("display-only legacy records never become verified assistant context", () => {
  const placeholder = { id: "orphan", role: "assistant" as const, content: `${INCOMPLETE_HISTORY_MARKER}unverified raw tool data` };
  const user = { id: "user", role: "user" as const, content: "Continue" };
  expect(sanitizeSeededHistory([placeholder, user])).toEqual([user]);
  expect(placeholder.content).toContain("unverified raw tool data");
});
