import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
export function tailnetUrl(value: string) {
  try {
    const u = new URL(value);
    const ip = u.hostname.split(".").map(Number);
    const tailIp =
      ip.length === 4 &&
      ip.every((n) => Number.isInteger(n) && n >= 0 && n < 256) &&
      ip[0] === 100 &&
      ip[1]! >= 64 &&
      ip[1]! <= 127;
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (tailIp || /^[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net$/.test(u.hostname)) &&
      /^\/v1\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
const model = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    baseUrl: z.string().refine(tailnetUrl),
    contextWindow: z.number().int().min(4096).max(2097152).default(131072),
    maxTokens: z.number().int().min(128).max(65536).default(8192),
  })
  .strict();
export const configSchema = z
  .object({
    piCommand: z.string().refine((s) => isAbsolute(s) && !s.includes("\0")),
    defaultModel: z.string(),
    models: z.array(model).min(1).max(8),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      new Set(c.models.map((m) => m.id)).size !== c.models.length ||
      !c.models.some((m) => m.id === c.defaultModel)
    )
      ctx.addIssue({ code: "custom", message: "Invalid model catalogue" });
  });
export type PiConfig = z.infer<typeof configSchema>;
export function loadConfig() {
  const file = process.env.OWNBOT_PI_ACP_CONFIG;
  if (!file || !isAbsolute(file))
    throw new Error("An operator Pi ACP config is required");
  const source = readFileSync(file, "utf8");
  return {
    config: configSchema.parse(JSON.parse(source)),
    fingerprint: createHash("sha256").update(source).digest("hex"),
  };
}
