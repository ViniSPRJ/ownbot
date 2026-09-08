import { createECDH, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const base64url = /^[A-Za-z0-9_-]+$/;
export type VapidConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};
export function readPushConfig(
  env: NodeJS.ProcessEnv = process.env,
): VapidConfig | null {
  try {
    const path = env.OPENBOT_WEB_PUSH_CONFIG;
    if (!path || !isAbsolute(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0)
      return null;
    const data = z
      .object({
        subject: z.string().max(200),
        publicKey: z.string().regex(base64url).length(87),
        privateKey: z.string().regex(base64url).length(43),
      })
      .strict()
      .parse(JSON.parse(readFileSync(path, "utf8")));
    const subject = new URL(data.subject);
    if (
      !["mailto:", "https:"].includes(subject.protocol) ||
      subject.username ||
      subject.password ||
      subject.hash
    )
      return null;
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(Buffer.from(data.privateKey, "base64url"));
    if (curve.getPublicKey().toString("base64url") !== data.publicKey)
      return null;
    return data;
  } catch {
    return null;
  }
}

/** Exact browser push services; neither arbitrary HTTPS nor private/Tailnet URLs are accepted. */
export function pushEndpointAllowed(raw: string): boolean {
  try {
    if (raw.length > 2048 || raw.length < 20) return false;
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port)
      return false;
    if (u.hostname === "fcm.googleapis.com")
      return /^\/(fcm\/send|wp)\/[^/]+/.test(u.pathname);
    if (u.hostname === "updates.push.services.mozilla.com")
      return /^\/wpush\/v[12]\/[^/]+/.test(u.pathname);
    if (u.hostname === "web.push.apple.com") return u.pathname.length > 1;
    if (/^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname))
      return u.pathname === "/w/";
    return false;
  } catch {
    return false;
  }
}
export const pushEndpointHash = (endpoint: string) =>
  createHash("sha256").update(endpoint).digest("hex");
const key = (bytes: number) =>
  z
    .string()
    .max(100)
    .regex(base64url)
    .refine((v) => Buffer.from(v, "base64url").length === bytes);
const subscriptionSchema = z
  .object({
    endpoint: z.string().refine(pushEndpointAllowed),
    expirationTime: z.number().finite().positive().nullable().optional(),
    keys: z
      .object({
        p256dh: key(65).refine((v) => Buffer.from(v, "base64url")[0] === 4),
        auth: key(16),
      })
      .strict(),
  })
  .strict();
export type PushSubscription = z.infer<typeof subscriptionSchema>;
export function parsePushSubscription(input: unknown): PushSubscription | null {
  const parsed = subscriptionSchema.safeParse(input);
  if (
    !parsed.success ||
    (parsed.data.expirationTime != null &&
      parsed.data.expirationTime <= Date.now())
  )
    return null;
  // Validate the public curve point using a temporary local key; no browser secrets leave here.
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(Buffer.from(parsed.data.keys.p256dh, "base64url"));
  } catch {
    return null;
  }
  return parsed.data;
}
export function genericPushPayload(notificationId: string): string {
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(notificationId))
    throw new Error("Invalid notification identifier");
  return JSON.stringify({
    title: "ownbot",
    body: "Há uma nova atualização no seu projeto.",
    notificationId:
      notificationId.length <= 64
        ? notificationId
        : pushEndpointHash(notificationId),
  });
}
