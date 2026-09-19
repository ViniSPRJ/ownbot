/**
 * Opt-in ACP + native Pi validation. Proves persisted session and granted-tool
 * roundtrip only. Does not assert model capacity or trading execution.
 */
import { ownbotEnv } from "../../shared/ownbot-env";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  configSchema,
  type PiConfig,
} from "../../integrations/pi-acp/src/config";
import { AcpPermissionGate } from "../src/acp/permissions";
import { createToolBridge } from "../src/acp/tool-bridge";
import { AcpStdioTransport } from "../src/acp/transport";

export const OPT_IN_ENV = "OWNBOT_VERIFY_LOCAL_PI";
export const OPT_IN_VALUE = "1";
export const TIMEOUT_MS = {
  min: 1_000,
  max: 3_600_000,
  default: 600_000,
} as const;

const PI_ACP_SERVER = resolve(
  import.meta.dir,
  "../../integrations/pi-acp/src/server.ts",
);
const MINIMAL_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const MAX_CONFIG_BYTES = 256 * 1024;
const CATALOGUE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export type VerifyArgs = {
  config: string;
  model: string;
  timeoutMs: number;
};

export type CatalogModel = PiConfig["models"][number];

export type VerifySummary = {
  model: { id: string; backend: string; baseUrl: string };
  sessionId: string;
  calls: { firstTurn: number; secondTurn: number; total: number };
  checks: {
    modelSelected: boolean;
    firstToolExecuted: boolean;
    firstNonceInText: boolean;
    sessionResumed: boolean;
    secondToolExecuted: boolean;
    noncesDiffer: boolean;
    bothNoncesInSecondText: boolean;
    callsIncreased: boolean;
  };
  timing: { elapsedMs: number };
};

type SessionConfiguration = {
  sessionId?: unknown;
  configOptions?: unknown;
};

function fail(message: string): never {
  throw new Error(message);
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`Missing value for ${flag}`);
  return value;
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  let config: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) break;
    if (!flag.startsWith("--")) fail("Unexpected argument");
    if (flag !== "--config" && flag !== "--model" && flag !== "--timeout-ms")
      fail("Unknown argument");
    const value = nextValue(argv, i, flag);
    i++;
    if (flag === "--config") {
      if (config !== undefined) fail("Duplicate --config");
      if (!isAbsolute(value) || value.includes("\0"))
        fail("--config must be an absolute path");
      config = value;
    } else if (flag === "--model") {
      if (model !== undefined) fail("Duplicate --model");
      if (!CATALOGUE_ID.test(value)) fail("--model must be a catalogue id");
      model = value;
    } else {
      if (timeoutMs !== undefined) fail("Duplicate --timeout-ms");
      if (!/^[0-9]+$/.test(value))
        fail("--timeout-ms must be a bounded integer");
      const parsed = Number(value);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < TIMEOUT_MS.min ||
        parsed > TIMEOUT_MS.max
      )
        fail("--timeout-ms must be a bounded integer");
      timeoutMs = parsed;
    }
  }
  if (config === undefined) fail("--config is required");
  if (model === undefined) fail("--model is required");
  return {
    config,
    model,
    timeoutMs: timeoutMs ?? TIMEOUT_MS.default,
  };
}

export function loadOperatorConfig(configPath: string): PiConfig {
  if (!isAbsolute(configPath) || configPath.includes("\0"))
    fail("Config path must be absolute");
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    fail("Operator Pi ACP config is unreadable");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
    fail("Operator Pi ACP config is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("Operator Pi ACP config is not JSON");
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) fail("Operator Pi ACP config is invalid");
  return result.data;
}

export function selectCatalogModel(
  config: PiConfig,
  modelId: string,
): CatalogModel {
  const selected = config.models.find((model) => model.id === modelId);
  if (!selected) fail("Requested model is not in the operator catalogue");
  return selected;
}

export function assertOptIn(env: NodeJS.ProcessEnv = process.env): void {
  if (ownbotEnv(env, OPT_IN_ENV) !== OPT_IN_VALUE)
    fail(`Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run real ACP+Pi validation`);
}

/** PATH plus the operator config path. Provider keys are not inherited. */
export function scopedAdapterEnv(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH && env.PATH.length > 0 ? env.PATH : MINIMAL_PATH,
    OWNBOT_PI_ACP_CONFIG: configPath,
  };
}

function sessionIdOf(value: SessionConfiguration): string {
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0)
    fail("ACP session id missing");
  return value.sessionId;
}

function selectedModelOf(value: SessionConfiguration): string | undefined {
  if (!Array.isArray(value.configOptions)) return;
  for (const option of value.configOptions) {
    if (!option || typeof option !== "object" || Array.isArray(option))
      continue;
    const entry = option as { id?: unknown; currentValue?: unknown };
    if (entry.id === "model" && typeof entry.currentValue === "string")
      return entry.currentValue;
  }
}

function chunkText(
  params: unknown,
  expectedSession: string | undefined,
): {
  update: unknown;
  text: string;
} {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return { update: undefined, text: "" };
  const event = params as {
    sessionId?: unknown;
    update?: {
      sessionUpdate?: unknown;
      content?: { type?: unknown; text?: unknown };
    };
  };
  if (
    expectedSession &&
    typeof event.sessionId === "string" &&
    event.sessionId !== expectedSession
  )
    return { update: undefined, text: "" };
  const text =
    event.update?.sessionUpdate === "agent_message_chunk" &&
    event.update.content?.type === "text" &&
    typeof event.update.content.text === "string"
      ? event.update.content.text
      : "";
  return { update: event.update, text };
}

async function runLiveVerify(
  args: VerifyArgs,
  selected: CatalogModel,
): Promise<VerifySummary> {
  if (!existsSync(PI_ACP_SERVER)) fail("Pi ACP server is missing");
  const started = Date.now();
  let cwd: string | undefined;
  let bridge: Awaited<ReturnType<typeof createToolBridge>> | undefined;
  let transport: AcpStdioTransport | undefined;
  const nonces: string[] = [];
  let calls = 0;
  let sessionId: string | undefined;
  let text = "";
  const gate = new AcpPermissionGate("pi", new Set(["verify_nonce"]));
  const onSignal = () => {
    transport?.close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const workspace = await mkdtemp(join(tmpdir(), "verify-local-pi-acp-"));
    cwd = workspace;
    bridge = await createToolBridge([
      {
        name: "verify_nonce",
        ref: "ownbot/verify_nonce",
        description:
          "Return a fresh unpredictable nonce. Call with an empty object. Harmless verification helper with no other effects.",
        parameters: z.object({}),
        execute: async () => {
          calls += 1;
          const nonce = randomBytes(16).toString("hex");
          nonces.push(nonce);
          return nonce;
        },
      },
    ]);
    const make = () =>
      new AcpStdioTransport({
        command: process.execPath,
        args: [PI_ACP_SERVER],
        cwd: workspace,
        env: scopedAdapterEnv(args.config),
        requestTimeoutMs: args.timeoutMs,
        onRequest: (method, params) => {
          if (method !== "session/request_permission")
            fail("Unsupported ACP client operation");
          return gate.decide(params, sessionId);
        },
        onNotification: (method, params) => {
          if (method !== "session/update") return;
          const chunk = chunkText(params, sessionId);
          if (chunk.update !== undefined) gate.observe(chunk.update);
          text += chunk.text;
        },
      });
    transport = make();
    await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const created = await transport.request<SessionConfiguration>(
      "session/new",
      { cwd, mcpServers: [bridge.descriptor] },
    );
    sessionId = sessionIdOf(created);
    const configured = await transport.request<SessionConfiguration>(
      "session/set_model",
      { sessionId, modelId: args.model },
    );
    const modelSelected = selectedModelOf(configured) === args.model;
    if (!modelSelected) fail("Session did not confirm the requested model");
    text = "";
    const firstPrompt = await transport.request<{ stopReason?: unknown }>(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Call the verify_nonce tool (ownbot__verify_nonce) exactly once with empty object arguments {}. After the tool returns, reply with the exact nonce string it returned. Do not invent a nonce. Do not call any other tool.",
          },
        ],
      },
    );
    if (firstPrompt.stopReason !== "end_turn")
      fail("First prompt did not complete a turn");
    const firstTurn = calls;
    const firstNonce = nonces[0];
    const firstText = text;
    const firstToolExecuted = firstTurn === 1;
    const firstNonceInText =
      typeof firstNonce === "string" && firstText.includes(firstNonce);
    if (!firstToolExecuted)
      fail("First turn did not execute verify_nonce exactly once");
    if (!firstNonceInText)
      fail("First turn text did not include the tool nonce");
    transport.close();
    transport = make();
    await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const loaded = await transport.request<SessionConfiguration>(
      "session/load",
      { sessionId, cwd, mcpServers: [bridge.descriptor] },
    );
    const sessionResumed =
      sessionIdOf(loaded) === sessionId &&
      selectedModelOf(loaded) === args.model;
    if (!sessionResumed)
      fail("Loaded session did not restore the same model session");
    text = "";
    const secondPrompt = await transport.request<{ stopReason?: unknown }>(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Recall the exact nonce from the previous turn. Call verify_nonce (ownbot__verify_nonce) exactly once again with empty object arguments {}. After it returns a new nonce, reply with both the previous nonce and this new nonce. Do not invent nonces. Do not call any other tool.",
          },
        ],
      },
    );
    if (secondPrompt.stopReason !== "end_turn")
      fail("Second prompt did not complete a turn");
    const secondTurn = calls - firstTurn;
    const secondNonce = nonces[1];
    const secondText = text;
    const secondToolExecuted = secondTurn === 1;
    const callsIncreased = calls > firstTurn;
    const noncesDiffer =
      typeof firstNonce === "string" &&
      typeof secondNonce === "string" &&
      secondNonce !== firstNonce;
    const bothNoncesInSecondText =
      typeof firstNonce === "string" &&
      typeof secondNonce === "string" &&
      secondText.includes(firstNonce) &&
      secondText.includes(secondNonce);
    if (!secondToolExecuted)
      fail("Second turn did not execute verify_nonce exactly once");
    if (!callsIncreased) fail("Tool call count did not increase after resume");
    if (!noncesDiffer) fail("Second turn did not return a different nonce");
    if (!bothNoncesInSecondText)
      fail("Second turn text did not include both nonces");
    return {
      model: {
        id: selected.id,
        backend: selected.model,
        baseUrl: selected.baseUrl,
      },
      sessionId,
      calls: { firstTurn, secondTurn, total: calls },
      checks: {
        modelSelected,
        firstToolExecuted,
        firstNonceInText,
        sessionResumed,
        secondToolExecuted,
        noncesDiffer,
        bothNoncesInSecondText,
        callsIncreased,
      },
      timing: { elapsedMs: Date.now() - started },
    };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    transport?.close();
    if (bridge) await bridge.close().catch(() => {});
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}

export async function runVerify(
  args: VerifyArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifySummary> {
  const config = loadOperatorConfig(args.config);
  const selected = selectCatalogModel(config, args.model);
  assertOptIn(env);
  return runLiveVerify(args, selected);
}

if (import.meta.main) {
  try {
    const summary = await runVerify(parseVerifyArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "verify-local-pi-acp failed"}\n`,
    );
    process.exit(1);
  }
}
