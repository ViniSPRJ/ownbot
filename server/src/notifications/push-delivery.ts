import { createHash } from "node:crypto";
import { request } from "node:https";
import webpush from "web-push";
import {
  genericPushPayload,
  type PushSubscription,
  parsePushSubscription,
  type VapidConfig,
} from "./push-config";

export type PushSend = (
  subscription: PushSubscription,
  notificationId: string,
  config: VapidConfig,
) => Promise<{ statusCode: number | null }>;
/** Use the maintained library for VAPID/encryption, with a bounded no-redirect HTTP transport. */
export const sendBrowserPush: PushSend = async (
  subscription,
  notificationId,
  config,
) => {
  if (!parsePushSubscription(subscription)) return { statusCode: 410 };
  const details = webpush.generateRequestDetails(
    subscription,
    genericPushPayload(notificationId),
    {
      vapidDetails: config,
      TTL: 300,
      urgency: "normal",
      contentEncoding: "aes128gcm",
      topic: createHash("sha256")
        .update(notificationId)
        .digest("base64url")
        .slice(0, 32),
    },
  );
  return new Promise((resolve) => {
    let completed = false;
    const finish = (statusCode: number | null) => {
      if (!completed) {
        completed = true;
        resolve({ statusCode });
      }
    };
    const req = request(
      details.endpoint,
      {
        method: details.method,
        headers: details.headers,
        agent: false,
        signal: AbortSignal.timeout(10000),
      },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) {
            req.destroy();
            finish(null);
          }
        });
        response.on("end", () => finish(response.statusCode ?? null));
        response.on("error", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.end(details.body);
  });
};
