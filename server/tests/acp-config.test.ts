import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpProfileFor } from "../src/acp/config";
const original = process.env.OPENBOT_ACP_CONFIG;
let temporary: string | undefined;
afterEach(() => {
  if (original === undefined) delete process.env.OPENBOT_ACP_CONFIG;
  else process.env.OPENBOT_ACP_CONFIG = original;
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});
function configure(value: unknown) {
  temporary = mkdtempSync(join(tmpdir(), "ownbot-acp-config-"));
  const file = join(temporary, "operator.json");
  writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
  process.env.OPENBOT_ACP_CONFIG = file;
}
const valid = () => ({
  profiles: {
    codex: { command: "/opt/bin/codex-acp", workspaceRoot: "/srv/ownbot" },
  },
  agents: { coord: "codex" },
});
describe("ACP operator config", () => {
  test("disabled ACP and unmapped bots remain unchanged", () => {
    delete process.env.OPENBOT_ACP_CONFIG;
    expect(acpProfileFor("coord")).toBeUndefined();
    configure(valid());
    expect(acpProfileFor("research")).toBeUndefined();
  });
  test("valid profile gets explicit defaults and preserves literal argv", () => {
    const config = valid();
    Object.assign(config.profiles.codex, {
      args: ["$(echo should-not-run)", "--acp"],
      env: { HOME: "/home/worker" },
      model: "model",
      mode: "read-only",
    });
    configure(config);
    expect(acpProfileFor("coord")).toEqual({
      profileId: "codex",
      command: "/opt/bin/codex-acp",
      workspaceRoot: "/srv/ownbot",
      args: ["$(echo should-not-run)", "--acp"],
      env: { HOME: "/home/worker" },
      model: "model",
      mode: "read-only",
      timeoutMs: 600000,
    });
  });
  test("relative config path and missing config fail closed", () => {
    process.env.OPENBOT_ACP_CONFIG = "./operator.json";
    expect(() => acpProfileFor("coord")).toThrow("absolute");
    process.env.OPENBOT_ACP_CONFIG = "/nonexistent/acp-config.json";
    expect(() => acpProfileFor("coord")).toThrow();
  });
  test("malformed JSON is rejected", () => {
    configure("{bad");
    expect(() => acpProfileFor("coord")).toThrow();
  });
  test("missing mapped profile is rejected", () => {
    configure({ profiles: {}, agents: { coord: "missing" } });
    expect(() => acpProfileFor("coord")).toThrow("missing");
  });
  for (const override of [
    { command: "codex-acp" },
    { workspaceRoot: "relative" },
    { command: "/bin/x\0evil" },
    { args: "--acp" },
    { args: ["nul\0argument"] },
    { env: { "BAD=KEY": "value" } },
    { env: { TOKEN: "nul\0value" } },
    { args: [42] },
    { env: { TOKEN: 42 } },
    { timeoutMs: 999 },
    { timeoutMs: 3600001 },
    { timeoutMs: 1000.5 },
    { shell: true },
    { unexpected: "value" },
  ])
    test(`invalid profile fails closed: ${JSON.stringify(override)}`, () => {
      const config = valid();
      Object.assign(config.profiles.codex, override);
      configure(config);
      expect(() => acpProfileFor("coord")).toThrow();
    });
  test("unknown top-level keys are rejected", () => {
    configure({ ...valid(), shell: true });
    expect(() => acpProfileFor("coord")).toThrow();
  });
  test("prototype property names cannot select inherited profiles or agents", () => {
    configure({ profiles: {}, agents: { coord: "toString" } });
    expect(() => acpProfileFor("coord")).toThrow("missing");
    expect(acpProfileFor("toString")).toBeUndefined();
  });
  test("empty profile mapping is rejected rather than silently reverting to API", () => {
    const config = valid();
    config.agents.coord = "";
    configure(config);
    expect(() => acpProfileFor("coord")).toThrow();
  });
});
