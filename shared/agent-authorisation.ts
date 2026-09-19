import { ownbotHeader } from "./ownbot-protocol";

/** Compare the caller's Bot token without leaking its contents through timing. */
export function matchesToken(expected: string, offered: string): boolean {
  if (expected.length === 0 || offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** OwnBot's managed-agent token, with a conflict-checked alias for existing peers. */
export function hasManagedAgentToken(
  request: Request,
  expected: string,
): boolean {
  return matchesToken(
    expected,
    ownbotHeader(request.headers, "agent-token")?.trim() ?? "",
  );
}
