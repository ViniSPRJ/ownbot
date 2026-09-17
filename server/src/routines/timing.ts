/** One policy for execution admission, abandoned-run recovery and readiness. */
export const ROUTINE_GRACE_MS = 10 * 60_000;
export function routineAbandonedRunMs(
  value = process.env.ROUTINE_TURN_TIMEOUT_MS,
): number {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0
    ? Math.max(10 * 60_000, timeout + 2 * 60_000)
    : 10 * 60_000;
}
