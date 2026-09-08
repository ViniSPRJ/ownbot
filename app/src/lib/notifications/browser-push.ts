export type UnsupportedReason = "no-push" | "insecure" | "ios-not-installed";

/** Only inspect standard API surfaces; pushManager belongs to a registration, not its container. */
export function pushSupport():
  | { supported: true; reason?: undefined }
  | { supported: false; reason: UnsupportedReason } {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return { supported: false, reason: "no-push" };
  if (!window.isSecureContext)
    return { supported: false, reason: "insecure" };
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (apple && !installed)
    return { supported: false, reason: "ios-not-installed" };
  const supported = "serviceWorker" in navigator &&
    "Notification" in window && "PushManager" in window &&
    "ServiceWorkerRegistration" in window &&
    "pushManager" in window.ServiceWorkerRegistration.prototype &&
    typeof window.PushManager.prototype.subscribe === "function" &&
    typeof globalThis.crypto?.subtle?.digest === "function";
  return supported ? { supported: true } : { supported: false, reason: "no-push" };
}

/** register() may resolve while the first worker is still installing. subscribe() requires active. */
export function waitForActiveWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs = 15_000,
  expectedScriptURL?: string,
): Promise<ServiceWorkerRegistration> {
  const ready = () => registration.active?.state === "activated" &&
    (!expectedScriptURL || registration.active.scriptURL === expectedScriptURL);
  if (ready()) return Promise.resolve(registration);
  return new Promise((resolve, reject) => {
    const watched = new Set<ServiceWorker>();
    const clean = () => {
      clearTimeout(timer);
      registration.removeEventListener("updatefound", inspect);
      for (const worker of watched) worker.removeEventListener("statechange", inspect);
    };
    const inspect = () => {
      if (ready()) {
        clean();
        resolve(registration);
        return;
      }
      const candidates = [registration.installing, registration.waiting, registration.active];
      for (const worker of candidates) if (worker && !watched.has(worker)) {
        watched.add(worker);
        worker.addEventListener("statechange", inspect);
      }
      if (watched.size > 0 && [...watched].every(worker => worker.state === "redundant")) {
        clean();
        reject(new Error("O navegador não conseguiu preparar os avisos. Recarregue e tente novamente."));
      }
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("A preparação dos avisos demorou demais. Recarregue e tente novamente."));
    }, timeoutMs);
    registration.addEventListener("updatefound", inspect);
    inspect();
  });
}

/** Prepare without subscribing or prompting; permission remains tied to the later enable click. */
export async function registerPushWorker(): Promise<ServiceWorkerRegistration> {
  // Re-registering the same script/scope is idempotent, and repairs a different or stale registration.
  const registration = await navigator.serviceWorker.register("/ownbot-push-sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
  return waitForActiveWorker(registration, 15_000, new URL("/ownbot-push-sw.js", window.location.href).href);
}
