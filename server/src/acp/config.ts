import { ownbotEnv } from "../../../shared/ownbot-env";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
const processText = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL is not allowed");
const absolutePath = processText.refine(isAbsolute);
const profile = z
  .object({
    command: absolutePath,
    provider: z.enum(["codex", "claude", "grok", "pi", "cursor"]).optional(),
    args: z.array(processText).default([]),
    workspaceRoot: absolutePath,
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), processText)
      .default({}),
    model: z.string().optional(),
    mode: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  })
  .strict();
const schema = z
  .object({
    /** Apply one of the two native CLIs to every current and future Bot. */
    cliOnly: z.boolean().optional(),
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), profile),
    agents: z.record(
      z.string().min(1),
      z.union([
        z.string().min(1),
        z
          .object({
            profile: z.string().min(1),
            model: z.string().trim().min(1).max(256).optional(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type AcpProfile = z.infer<typeof profile> & { profileId: string };
function readConfig() {
  const file = ownbotEnv(process.env, "OWNBOT_ACP_CONFIG");
  if (!file) return;
  if (!isAbsolute(file))
    throw new Error("OWNBOT_ACP_CONFIG must be an absolute path");
  const source = readFileSync(file, "utf8");
  const config = schema.parse(JSON.parse(source));
  if (
    config.defaultProfile &&
    !Object.hasOwn(config.profiles, config.defaultProfile)
  )
    throw new Error("Default ACP profile is missing");
  if (config.cliOnly) {
    if (!config.defaultProfile)
      throw new Error("CLI-only execution requires a default ACP profile");
    if (
      Object.values(config.profiles).some(
        (value) => !["codex", "cursor"].includes(value.provider ?? "codex"),
      )
    )
      throw new Error(
        "CLI-only execution accepts only Codex CLI and Cursor CLI",
      );
    if (ownbotEnv(process.env, "OWNBOT_PRIVATE_AGENT_IDS")?.trim())
      throw new Error(
        "Clear the private local runtime mapping before enabling CLI-only execution",
      );
  }
  return { file, source, config };
}

function mappingFor(config: z.infer<typeof schema>, agentId: string) {
  return Object.hasOwn(config.agents, agentId)
    ? config.agents[agentId]
    : config.defaultProfile;
}

/** Hash only the effective connection for this Bot, independent of JSON key order. */
function stableConfiguration(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableConfiguration).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableConfiguration(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function acpModelSelectionFor(agentId: string) {
  const loaded = readConfig();
  if (!loaded) return;
  const mapping = mappingFor(loaded.config, agentId);
  if (!mapping) return;
  const id = typeof mapping === "string" ? mapping : mapping.profile;
  if (!Object.hasOwn(loaded.config.profiles, id))
    throw new Error("ACP profile is missing");
  const base = loaded.config.profiles[id]!;
  const selectedModel = typeof mapping === "string" ? undefined : mapping.model;
  const effective: AcpProfile = {
    ...base,
    ...(selectedModel ? { model: selectedModel } : {}),
    profileId: id,
  };
  return {
    profile: effective,
    selectedModel: selectedModel ?? null,
    defaultModel: base.model ?? null,
    conversationRevision: `profile-v1:${createHash("sha256").update(stableConfiguration(effective)).digest("hex")}`,
    // File-wide revision protects concurrent administrative edits; it is not a conversation key.
    revision: createHash("sha256").update(loaded.source).digest("hex"),
  };
}

/** Called only by the administrator model endpoint, after validating the CLI's catalogue. */
export function saveAcpAgentModel(
  agentId: string,
  model: string | null,
  revision: string,
) {
  const loaded = readConfig();
  if (
    !loaded ||
    createHash("sha256").update(loaded.source).digest("hex") !== revision
  )
    throw new Error("ACP configuration changed");
  const mapping = mappingFor(loaded.config, agentId);
  if (!mapping) throw new Error("ACP agent not mapped");
  const id = typeof mapping === "string" ? mapping : mapping.profile;
  const value = model === null ? id : { profile: id, model };
  // Preserve the operator's original fields and other agents byte-for-value; never accept
  // executable paths or environments from the browser.
  const original = JSON.parse(loaded.source);
  original.agents[agentId] = value;
  schema.parse(original);
  const temporary = `${loaded.file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(original, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, loaded.file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** Operator-owned configuration, never command text supplied by a chat or agent. */
export function acpProfileFor(agentId: string): AcpProfile | undefined {
  return acpModelSelectionFor(agentId)?.profile;
}

/** Public catalogue contains only operator-defined connection IDs and provider names. */
export function acpProviderSelectionFor(agentId: string) {
  const loaded = readConfig();
  if (!loaded) return;
  const mapping = mappingFor(loaded.config, agentId);
  if (!mapping) return;
  const profileId = typeof mapping === "string" ? mapping : mapping.profile;
  if (!Object.hasOwn(loaded.config.profiles, profileId))
    throw new Error("ACP profile is missing");
  return {
    profileId,
    profiles: Object.entries(loaded.config.profiles).map(([id, value]) => ({
      id,
      provider: value.provider ?? "codex",
    })),
    revision: createHash("sha256").update(loaded.source).digest("hex"),
  };
}

/** Resolve only installed operator profiles. Browser input never becomes process configuration. */
export function configuredAcpProfile(
  profileId: string,
): AcpProfile | undefined {
  const loaded = readConfig();
  if (!loaded || !Object.hasOwn(loaded.config.profiles, profileId)) return;
  return { ...loaded.config.profiles[profileId]!, profileId };
}

/** Synchronous read/revision-check/rename prevents an intervening in-process save. */
export function saveAcpAgentProvider(
  agentId: string,
  profileId: string,
  revision: string,
) {
  const loaded = readConfig();
  if (
    !loaded ||
    createHash("sha256").update(loaded.source).digest("hex") !== revision
  )
    throw new Error("ACP configuration changed");
  if (
    !mappingFor(loaded.config, agentId) ||
    !Object.hasOwn(loaded.config.profiles, profileId)
  )
    throw new Error("ACP agent or profile not configured");
  const mapping = mappingFor(loaded.config, agentId)!;
  const previous = typeof mapping === "string" ? mapping : mapping.profile;
  // An unchanged provider must preserve the user's model override.
  if (previous === profileId) return;
  const original = JSON.parse(loaded.source);
  // A different connection may use an unrelated model catalogue; use its own default.
  original.agents[agentId] = profileId;
  schema.parse(original);
  const temporary = `${loaded.file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(original, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, loaded.file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
