/** Accept old peers during upgrades without allowing conflicting identity headers. */
export function ownbotHeader(
  headers: { get(name: string): string | null },
  suffix: string,
): string | null {
  const current = headers.get(`x-ownbot-${suffix}`);
  const legacy = headers.get(`x-openbot-${suffix}`);
  if (current !== null && legacy !== null && current.trim() !== legacy.trim()) {
    return null;
  }
  return current ?? legacy;
}

/** Read a signed run assertion, rejecting disagreeing aliases rather than guessing identity. */
export function ownbotRunAssertion(
  props: Record<string, unknown> | undefined,
): unknown {
  if (!props) return undefined;
  const current = props.ownbotRun;
  const legacy = props.openbotRun;
  if (current !== undefined && legacy !== undefined && current !== legacy)
    return undefined;
  return current !== undefined ? current : legacy;
}
