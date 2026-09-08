import { readPushConfig, type VapidConfig } from "./push-config";
import { type PushSend, sendBrowserPush } from "./push-delivery";
import type { PushStore } from "./push-store";

/** Each replica may run this poller; SQL leases and row locks serialize a notification/device. */
export function startPushWorker(
  store: Pick<PushStore, "claim" | "deliver" | "prune">,
  options: {
    config?: () => VapidConfig | null;
    send?: PushSend;
    intervalMs?: number;
    onError?: () => void;
  } = {},
) {
  const config = options.config ?? readPushConfig;
  const send = options.send ?? sendBrowserPush;
  let stopped = false;
  let active: Promise<void> | undefined;
  let cycles = 0;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      if (!config()) return;
      if (cycles++ % 60 === 0) await store.prune();
      for (let i = 0; i < 10 && !stopped; i++) {
        const current = config();
        if (!current) break;
        const claim = await store.claim();
        if (!claim) break;
        await store.deliver(claim, current, send);
      }
    })()
      .catch(() => options.onError?.())
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? 5000);
  timer.unref?.();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
