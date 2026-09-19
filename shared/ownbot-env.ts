/** Read OwnBot configuration while honoring existing deployments' legacy names.
 * An explicitly empty canonical value wins too: it must never re-enable a legacy flag.
 * Values are read at call time without modifying the caller's environment.
 */
export function ownbotEnv(
  environment: Record<string, string | undefined>,
  name: `OWNBOT_${string}`,
): string | undefined {
  return environment[name] ?? environment[name.replace(/^OWNBOT_/, "OPENBOT_")];
}
