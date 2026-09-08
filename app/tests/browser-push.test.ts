import { afterEach, expect, test } from "bun:test";
import { pushSupport, registerPushWorker, waitForActiveWorker } from "../src/lib/notifications/browser-push";

const originals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function browser({ apple = false, installed = false, standalone = false, secure = true } = {}) {
  class Registration {
    // WebIDL getters cannot be invoked on their prototype; support detection must not invoke this.
    get pushManager(): never { throw new Error("Illegal invocation"); }
  }
  class PushManager { subscribe() {} }
  const window = {
    isSecureContext: secure, location: { href: "https://ownbot.example/notifications" },
    matchMedia: () => ({ matches: installed }),
    Notification: class {}, PushManager, ServiceWorkerRegistration: Registration,
  };
  const navigator = {
    userAgent: apple ? "iPhone" : "Chrome", platform: apple ? "iPhone" : "MacIntel",
    maxTouchPoints: 0, standalone, serviceWorker: {},
  };
  // There is deliberately no ServiceWorkerContainer.pushManager: ordinary Web Push never needs it.
  global("window", window); global("navigator", navigator);
  return { window, navigator };
}

test("standard registration-based Web Push is supported without a container pushManager", () => {
  browser(); expect(pushSupport()).toEqual({ supported: true });
});
test("iPhone Home Screen detection accepts navigator.standalone, not window.standalone", () => {
  browser({ apple: true, standalone: true }); expect(pushSupport()).toEqual({ supported: true });
});
test("iPhone standalone display mode also supports Web Push", () => {
  browser({ apple: true, installed: true }); expect(pushSupport()).toEqual({ supported: true });
});
test("ordinary iPhone browser explains the Home Screen requirement", () => {
  browser({ apple: true }); expect(pushSupport()).toEqual({ supported: false, reason: "ios-not-installed" });
});
test("unsupported and insecure browsers are still refused", () => {
  browser({ secure: false }); expect(pushSupport()).toEqual({ supported: false, reason: "insecure" });
  const { window } = browser(); Reflect.deleteProperty(window, "PushManager");
  expect(pushSupport()).toEqual({ supported: false, reason: "no-push" });
});
test("capability checks never create a registration or request permission", () => {
  const { navigator, window } = browser();
  Object.assign(navigator.serviceWorker, { register: () => { throw new Error("unexpected registration"); } });
  Object.assign(window.Notification, { requestPermission: () => { throw new Error("unexpected prompt"); } });
  expect(pushSupport().supported).toBe(true);
});

class Worker extends EventTarget {
  state: ServiceWorkerState = "installing";
  scriptURL = "https://ownbot.example/ownbot-push-sw.js";
  change(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}
class Registration extends EventTarget {
  active: Worker | null = null;
  installing: Worker | null = new Worker();
  waiting: Worker | null = null;
  get native() { return this as unknown as ServiceWorkerRegistration; }
}
test("first subscription waits for activation even when register() has already returned", async () => {
  const { navigator } = browser(); const registration = new Registration();
  const calls: unknown[] = [];
  Object.assign(navigator.serviceWorker, { register: async (...args: unknown[]) => { calls.push(args); return registration; } });
  let ready = false;
  const pending = registerPushWorker().then(value => { ready = true; return value; });
  await Promise.resolve(); await Promise.resolve(); expect(ready).toBe(false);
  registration.installing!.change("installed"); await Promise.resolve(); expect(ready).toBe(false);
  registration.active = registration.installing;
  registration.active!.change("activated");
  expect(await pending).toBe(registration.native);
  expect(calls).toEqual([["/ownbot-push-sw.js", { scope: "/", updateViaCache: "none" }]]);
});
test("a preexisting active ownbot worker is immediately usable", async () => {
  const registration = new Registration(); registration.active = registration.installing;
  registration.active!.state = "activated";
  expect(await waitForActiveWorker(registration.native)).toBe(registration.native);
});
test("an older different worker cannot be mistaken for the ownbot push handler", async () => {
  const registration = new Registration(); registration.active = new Worker();
  registration.active.state = "activated"; registration.active.scriptURL = "https://ownbot.example/old-sw.js";
  let ready = false;
  const pending = waitForActiveWorker(registration.native, 100, "https://ownbot.example/ownbot-push-sw.js").then(() => { ready = true; });
  await Promise.resolve(); expect(ready).toBe(false);
  registration.active = registration.installing; registration.active!.change("activated");
  await pending; expect(ready).toBe(true);
});
test("a failed first installation ends with an actionable error", async () => {
  const registration = new Registration(); const pending = waitForActiveWorker(registration.native);
  registration.installing!.change("redundant");
  await expect(pending).rejects.toThrow("não conseguiu preparar");
});
test("a stalled worker cannot leave the activation button busy forever", async () => {
  await expect(waitForActiveWorker(new Registration().native, 5)).rejects.toThrow("demorou demais");
});
