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
    provider: z.enum(["codex", "claude", "grok"]).optional(),
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
  const file = process.env.OPENBOT_ACP_CONFIG;
  if (!file) return;
  if (!isAbsolute(file))
    throw new Error("OPENBOT_ACP_CONFIG must be an absolute path");
  const source = readFileSync(file, "utf8");
  return { file, source, config: schema.parse(JSON.parse(source)) };
}

export function acpModelSelectionFor(agentId: string) {
  const loaded = readConfig();
  if (!loaded || !Object.hasOwn(loaded.config.agents, agentId)) return;
  const mapping = loaded.config.agents[agentId]!;
  const id = typeof mapping === "string" ? mapping : mapping.profile;
  if (!Object.hasOwn(loaded.config.profiles, id))
    throw new Error("ACP profile is missing");
  const base = loaded.config.profiles[id]!;
  const selectedModel = typeof mapping === "string" ? undefined : mapping.model;
  return {
    profile: {
      ...base,
      ...(selectedModel ? { model: selectedModel } : {}),
      profileId: id,
    } as AcpProfile,
    selectedModel: selectedModel ?? null,
    defaultModel: base.model ?? null,
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
  const mapping = loaded.config.agents[agentId];
  if (!mapping || !Object.hasOwn(loaded.config.agents, agentId))
    throw new Error("ACP agent not mapped");
  const id = typeof mapping === "string" ? mapping : mapping.profile;
  const value = model === null ? id : { profile: id, model };
  // Preserve the operator's original fields and other agents byte-for-value; never accept
  // executable paths, environments or provider choices from the browser.
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
