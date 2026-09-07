import { readFileSync } from "node:fs";
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
    agents: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
export type AcpProfile = z.infer<typeof profile> & { profileId: string };
/** Operator-owned configuration, never command text supplied by a chat or agent. */
export function acpProfileFor(agentId: string): AcpProfile | undefined {
  const file = process.env.OPENBOT_ACP_CONFIG;
  if (!file) return;
  if (!isAbsolute(file))
    throw new Error("OPENBOT_ACP_CONFIG must be an absolute path");
  const config = schema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (!Object.hasOwn(config.agents, agentId)) return;
  const id = config.agents[agentId];
  if (!id) return;
  if (!Object.hasOwn(config.profiles, id))
    throw new Error("ACP profile is missing");
  const selected = config.profiles[id];
  if (!selected) throw new Error("ACP profile is missing");
  return { ...selected, profileId: id };
}
