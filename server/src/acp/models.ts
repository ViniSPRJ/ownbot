import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AcpProfile } from "./config";
import { AcpStdioTransport } from "./transport";

export type ModelCatalogue = {
  currentModel: string | null;
  models: { id: string; name: string }[];
  configId?: string;
};
type SessionConfiguration = { configOptions?: unknown; models?: unknown };
const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Prefer the advertised model selector; old adapters expose session.models instead. */
export function sessionModels(session: SessionConfiguration): ModelCatalogue {
  const config = Array.isArray(session.configOptions)
    ? session.configOptions
        .map(object)
        .find(
          (c) =>
            c?.type === "select" &&
            (c.category === "model" || (!c.category && c.id === "model")),
        )
    : undefined;
  const models: ModelCatalogue["models"] = [];
  const add = (id: unknown, name: unknown) => {
    if (text(id) && text(name) && !models.some((m) => m.id === id))
      models.push({ id, name });
  };
  if (config) {
    for (const entry of Array.isArray(config.options) ? config.options : []) {
      const option = object(entry);
      if (Array.isArray(option?.options))
        for (const nested of option.options) add(nested?.value, nested?.name);
      else add(option?.value, option?.name);
    }
    return {
      models,
      currentModel: text(config.currentValue) ? config.currentValue : null,
      ...(text(config.id) ? { configId: config.id } : {}),
    };
  }
  const legacy = object(session.models);
  for (const entry of Array.isArray(legacy?.availableModels)
    ? legacy.availableModels
    : [])
    add(entry?.modelId, entry?.name);
  return {
    models,
    currentModel: text(legacy?.currentModelId) ? legacy.currentModelId : null,
  };
}

export function acpEnvironment(profile: AcpProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "PATH",
    "USER",
    "LANG",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ])
    if (process.env[name]) env[name] = process.env[name];
  return Object.assign(env, profile.env);
}

export async function selectSessionModel(
  transport: Pick<AcpStdioTransport, "request">,
  sessionId: string,
  session: SessionConfiguration,
  model: string,
) {
  const catalogue = sessionModels(session);
  if (
    catalogue.models.length > 0 &&
    !catalogue.models.some((m) => m.id === model)
  )
    throw new Error("O modelo selecionado não está disponível nesta CLI.");
  if (catalogue.configId) {
    const changed = await transport.request<SessionConfiguration>(
      "session/set_config_option",
      { sessionId, configId: catalogue.configId, value: model },
    );
    if (sessionModels(changed).currentModel !== model)
      throw new Error("A CLI não confirmou o modelo selecionado.");
  } else {
    await transport.request("session/set_model", { sessionId, modelId: model });
  }
}

const pending = new Map<string, Promise<ModelCatalogue>>();
const cached = new Map<string, { value: ModelCatalogue; until: number }>();
/** A bounded, prompt-free ACP session. No task/history, MCP tools or native permissions. */
export async function discoverAcpModels(
  profile: AcpProfile,
): Promise<ModelCatalogue> {
  const key = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
  const existing = cached.get(key);
  if (existing && existing.until > Date.now()) return existing.value;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 4) throw new Error("ACP model discovery busy");
  const work = (async () => {
    await mkdir(profile.workspaceRoot, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(profile.workspaceRoot, ".models-"));
    let transport: AcpStdioTransport | undefined;
    try {
      transport = new AcpStdioTransport({
        command: profile.command,
        args: profile.args,
        cwd,
        env: acpEnvironment(profile),
        requestTimeoutMs: 20000,
        onRequest: (method) => {
          if (method === "session/request_permission")
            return { outcome: { outcome: "cancelled" } };
          throw new Error("Model discovery has no client tools");
        },
      });
      const init = await transport.request<{ protocolVersion: number }>(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "ownbot-model-selector", version: "1" },
        },
      );
      if (init.protocolVersion !== 1)
        throw new Error("Unsupported ACP version");
      const session = await transport.request<SessionConfiguration>(
        "session/new",
        { cwd, mcpServers: [] },
      );
      const value = sessionModels(session);
      if (cached.size >= 32) cached.clear();
      cached.set(key, { value, until: Date.now() + 60000 });
      return value;
    } finally {
      transport?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  })();
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}
