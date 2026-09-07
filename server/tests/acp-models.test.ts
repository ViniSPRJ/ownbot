import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acpModelSelectionFor,
  acpProfileFor,
  saveAcpAgentModel,
} from "../src/acp/config";
import {
  discoverAcpModels,
  selectSessionModel,
  sessionModels,
} from "../src/acp/models";

const previous = process.env.OPENBOT_ACP_CONFIG;
let root: string;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENBOT_ACP_CONFIG;
  else process.env.OPENBOT_ACP_CONFIG = previous;
  if (root) rmSync(root, { recursive: true, force: true });
});
function setup() {
  root = mkdtempSync(join(tmpdir(), "ownbot-models-"));
  const file = join(root, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        codex: {
          command: "/bin/codex",
          workspaceRoot: root,
          model: "default",
          env: { PRIVATE_TOKEN: "secret" },
        },
      },
      agents: { coord: "codex", quant: "codex" },
    }),
  );
  process.env.OPENBOT_ACP_CONFIG = file;
  return file;
}
const modern = {
  configOptions: [
    {
      id: "engine",
      category: "model",
      type: "select",
      currentValue: "small",
      options: [
        { value: "small", name: "Small" },
        { value: "large", name: "Large" },
      ],
    },
  ],
};

test("two roles share one CLI but persist independent models without modifying prompts or credentials", () => {
  const file = setup();
  const original = JSON.parse(readFileSync(file, "utf8"));
  saveAcpAgentModel("coord", "large", acpModelSelectionFor("coord")!.revision);
  saveAcpAgentModel("quant", "small", acpModelSelectionFor("quant")!.revision);
  expect(acpProfileFor("coord")!.model).toBe("large");
  expect(acpProfileFor("quant")!.model).toBe("small");
  expect(acpProfileFor("coord")!.command).toBe(acpProfileFor("quant")!.command);
  expect(JSON.parse(readFileSync(file, "utf8")).profiles).toEqual(
    original.profiles,
  );
  saveAcpAgentModel("coord", null, acpModelSelectionFor("coord")!.revision);
  expect(acpProfileFor("coord")!.model).toBe("default");
  expect(acpProfileFor("quant")!.model).toBe("small");
});
test("a stale selector cannot overwrite an administrator's intervening change", () => {
  const file = setup();
  const stale = acpModelSelectionFor("coord")!.revision;
  saveAcpAgentModel("quant", "small", stale);
  const current = readFileSync(file, "utf8");
  expect(() => saveAcpAgentModel("coord", "large", stale)).toThrow("changed");
  expect(readFileSync(file, "utf8")).toBe(current);
});
test("modern selectors, including groups, supersede legacy models without exposing other settings", () => {
  expect(
    sessionModels({
      ...modern,
      models: {
        currentModelId: "old",
        availableModels: [{ modelId: "old", name: "Old" }],
      },
    }),
  ).toEqual({
    currentModel: "small",
    models: [
      { id: "small", name: "Small" },
      { id: "large", name: "Large" },
    ],
    configId: "engine",
  });
  expect(
    sessionModels({
      configOptions: [
        {
          id: "model",
          type: "select",
          currentValue: "m",
          options: [
            { name: "Group", options: [{ value: "m", name: "Model" }] },
          ],
        },
      ],
    }).models,
  ).toEqual([{ id: "m", name: "Model" }]);
  expect(
    sessionModels({
      models: {
        currentModelId: "old",
        availableModels: [{ modelId: "old", name: "Old" }],
      },
    }),
  ).toEqual({ currentModel: "old", models: [{ id: "old", name: "Old" }] });
});
test("selection uses the advertised config id, verifies acknowledgement and refuses unavailable models", async () => {
  const calls: unknown[] = [];
  const transport = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return {
        configOptions: [{ ...modern.configOptions[0], currentValue: "large" }],
      };
    },
  } as any;
  await selectSessionModel(transport, "session-1", modern, "large");
  expect(calls).toEqual([
    [
      "session/set_config_option",
      { sessionId: "session-1", configId: "engine", value: "large" },
    ],
  ]);
  await expect(
    selectSessionModel(transport, "session-1", modern, "not-listed"),
  ).rejects.toThrow("não está disponível");
  expect(calls.length).toBe(1);
  await expect(
    selectSessionModel(
      { request: async () => modern } as any,
      "session-1",
      modern,
      "large",
    ),
  ).rejects.toThrow("não confirmou");
});
test("legacy adapters still use set_model without an API fallback", async () => {
  const calls: unknown[] = [];
  await selectSessionModel(
    {
      request: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as any,
    "session",
    {},
    "legacy",
  );
  expect(calls).toEqual([
    ["session/set_model", { sessionId: "session", modelId: "legacy" }],
  ]);
});
test("live discovery protocol never prompts or grants tools, coalesces duplicate requests and cleans its workspace", async () => {
  setup();
  const log = join(root, "calls.jsonl");
  const fixture = `
    import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
    const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(process.env.LOG,JSON.stringify(m)+'\\n');
    if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
    else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(modern)}});
    else send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'no tasks allowed'}});});`;
  const profile = {
    profileId: "test",
    command: process.execPath,
    args: ["-e", fixture],
    workspaceRoot: root,
    env: { LOG: log },
    timeoutMs: 5000,
  };
  const [a, b] = await Promise.all([
    discoverAcpModels(profile),
    discoverAcpModels(profile),
  ]);
  expect(a).toEqual(b);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
  expect(calls[1].params.mcpServers).toEqual([]);
  expect(await Bun.file(join(calls[1].params.cwd, "anything")).exists()).toBe(
    false,
  );
});
