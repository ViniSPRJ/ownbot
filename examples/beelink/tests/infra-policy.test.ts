import { test, expect } from "bun:test";
import boundary from "../read-only-boundary.json";
import { evaluateActionPolicy, type PolicyContext } from "../../../server/src/computer/policy";
const policy = { mode: "enforce" as const, allow: ["true"], deny: [boundary.deny] };
function decide(bot: string, mcp?: PolicyContext["mcp"]) {
  return evaluateActionPolicy(policy, {bot: {id:bot}, actor:{id:"test"},
    tool:{name:mcp ? "mcp" : "computer_exec"}, page:{url:"",host:""}, ...(mcp ? {mcp}: {})});
}
test("infra exact reads pass while restart, cron and arbitrary servers are blocked", () => {
  for (const tool of ["status", "health", "disk"])
    expect(decide("infra", {server:"vps-ops",tool,effect:"read"}).forward).toBe(true);
  for (const tool of ["restart", "hermes_cron", "logs"])
    expect(decide("infra", {server:"vps-ops",tool,effect:"read"}).forward).toBe(false);
  expect(decide("infra", {server:"evil",tool:"status",effect:"read"}).forward).toBe(false);
  expect(decide("infra").forward).toBe(false);
});
test("onyx has no computer or MCP exception until a scoped connector exists", () => {
  expect(decide("onyx").forward).toBe(false);
  expect(decide("onyx", {server:"vps-ops",tool:"status",effect:"read"}).forward).toBe(false);
});
test("other coworkers retain existing policy and deny beats permissive allow", () => {
  expect(decide("coord").forward).toBe(true);
  expect(decide("codeexec").forward).toBe(true);
});
