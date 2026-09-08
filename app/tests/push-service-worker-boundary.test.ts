import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The push service worker's boundary, tested as the browser will run it: source in, notification out.
 *
 * `app/public/ownbot-push-sw.js` is not compiled, not imported by the app, and not reachable from a
 * happy-dom render, so nothing else in the suite ever executes it. That matters because the file is the
 * only place a push message — a blob that arrives through a third-party push service, unauthenticated in
 * transit — touches the screen. So this file evaluates it against a fake `self` and asserts the four
 * things that are actually load-bearing:
 *
 * 1. it registers install/activate/push/notificationclick and no `fetch`, and never touches `caches`;
 * 2. a push always produces exactly one notification with our fixed title and body, whatever the payload
 *    claims, and nothing the payload sent reaches the notification's fields;
 * 3. `notificationId` becomes the tag only when it is a short plain token, otherwise the shared tag;
 * 4. a click goes to `/notifications` on our own origin — focus an own tab, else open one — and never to
 *    an address from the payload.
 */

type FakeWindow = {
  url: string;
  focused: number;
  navigated: string[];
  canNavigate: boolean;
};

type Harness = {
  listeners: string[];
  shown: { title: string; options: Record<string, unknown> }[];
  opened: string[];
  cacheTouches: string[];
  counts: { fetch: number; closed: number };
  windowStates: FakeWindow[];
  fire: (type: string, event: Record<string, unknown>) => Promise<void>;
};

function worker(
  entries: { url: string; canNavigate?: boolean }[] = [],
): Harness {
  const source = readFileSync(
    join(import.meta.dir, "../public/ownbot-push-sw.js"),
    "utf8",
  );
  const listeners = new Map<string, (event: never) => void>();
  const shown: Harness["shown"] = [];
  const opened: string[] = [];
  const cacheTouches: string[] = [];
  const counts = { fetch: 0, closed: 0 };

  const windowStates: FakeWindow[] = entries.map((entry) => ({
    url: entry.url,
    focused: 0,
    navigated: [],
    canNavigate: entry.canNavigate !== false,
  }));

  /* Any property read on `caches` is recorded, so "no cache handler" is a measured claim, not a grep. */
  const caches = new Proxy(
    {},
    {
      get: (_target, property) => {
        cacheTouches.push(String(property));
        throw new Error("the push worker must not use caches");
      },
    },
  );
  const fetchTrap = () => {
    counts.fetch += 1;
    throw new Error("the push worker must not fetch");
  };

  const self = {
    location: { origin: "https://ownbot.example" },
    clients: {
      matchAll: async () =>
        windowStates.map((state) => ({
          url: state.url,
          focus: async () => {
            state.focused += 1;
          },
          /* `navigate` is missing on some engines; the worker has to cope with both shapes. */
          ...(state.canNavigate
            ? {
                navigate: async (target: string) => {
                  state.navigated.push(target);
                },
              }
            : {}),
        })),
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
      claim: async () => {},
    },
    registration: {
      showNotification: async (
        title: string,
        options?: Record<string, unknown>,
      ) => {
        shown.push({ title, options: options ?? {} });
      },
    },
    skipWaiting: async () => {},
    addEventListener: (type: string, handler: (event: never) => void) => {
      listeners.set(type, handler);
    },
  };

  new Function("self", "caches", "fetch", source)(self, caches, fetchTrap);

  return {
    listeners: [...listeners.keys()].sort(),
    shown,
    opened,
    cacheTouches,
    counts,
    windowStates,
    fire: async (type, event) => {
      const waited: Promise<unknown>[] = [];
      const complete = {
        ...event,
        notification: { close: () => (counts.closed += 1) },
        waitUntil: (promise: Promise<unknown>) => {
          waited.push(promise);
        },
      } as never;
      listeners.get(type)?.(complete);
      await Promise.all(waited);
    },
  };
}

const push = (data: unknown) => ({ data });

test("the push worker listens to push and clicks, and to nothing that could serve content", async () => {
  const worker_ = worker();
  expect(worker_.listeners).toEqual([
    "activate",
    "install",
    "notificationclick",
    "push",
  ]);

  await worker_.fire("install", {});
  await worker_.fire("activate", {});
  await worker_.fire("push", push(null));

  expect(worker_.cacheTouches).toEqual([]);
  expect(worker_.counts.fetch).toBe(0);
  const source = readFileSync(
    join(import.meta.dir, "../public/ownbot-push-sw.js"),
    "utf8",
  );
  expect(source.includes('addEventListener("fetch"')).toBe(false);
  // No CacheStorage call of any shape: `caches.open(`, `cache.match(`, ` caches ` as an expression.
  expect(/\bcaches\s*\./.test(source)).toBe(false);
  expect(/\bcaches\s*[),\]]/.test(source)).toBe(false);
});

test("a push is one generic notification, and the payload cannot write on it", async () => {
  const worker_ = worker();
  await worker_.fire(
    "push",
    push({
      text: () =>
        JSON.stringify({
          notificationId: "run-7",
          title: "Proposta Acme — R$ 12.000",
          body: "O cliente aceitou a proposta",
          url: "https://evil.example/phishing",
          image: "https://evil.example/logo.png",
          notification: { body: "segredo" },
          actions: [{ title: "Abrir", action: "https://evil.example" }],
        }),
    }),
  );

  expect(worker_.shown).toHaveLength(1);
  const { title, options } = worker_.shown[0]!;
  expect(title).toBe("ownbot");
  expect(options.body).toBe("Há uma nova atualização no seu projeto.");
  expect(options.tag).toBe("run-7");
  expect("data" in options).toBe(false);
  /* Nothing the payload claimed reached any field of the notification. */
  expect(JSON.stringify(options)).not.toContain("evil.example");
  expect(JSON.stringify(options)).not.toContain("Acme");
  expect(JSON.stringify(options)).not.toContain("12.000");
  expect(JSON.stringify(options)).not.toContain("segredo");
});

test("the notification is shown whatever the payload is, with the shared tag", async () => {
  const payloads: unknown[] = [
    null,
    undefined,
    { text: () => "" },
    /* `text()` throwing is the encrypted-empty-body case, not a reason to stay silent. */
    {
      get text() {
        return () => {
          throw new Error("encrypted body");
        };
      },
    },
    { text: () => "not json at all" },
    { text: () => "[1,2,3]" },
    { text: () => "null" },
    { text: () => '"run-7"' },
    { text: () => JSON.stringify({ notificationId: 7 }) },
    { text: () => JSON.stringify({ notificationId: "" }) },
    { text: () => JSON.stringify({ notificationId: "   " }) },
    { text: () => JSON.stringify({ notificationId: "a/b?redirect=1" }) },
    {
      text: () => JSON.stringify({ notificationId: `run-${"x".repeat(200)}` }),
    },
  ];

  const worker_ = worker();
  for (const payload of payloads) await worker_.fire("push", push(payload));

  expect(worker_.shown).toHaveLength(payloads.length);
  for (const shown of worker_.shown) {
    expect(shown.title).toBe("ownbot");
    expect(shown.options.body).toBe("Há uma nova atualização no seu projeto.");
    expect(shown.options.tag).toBe("ownbot");
    expect(typeof shown.options.tag).toBe("string");
    expect((shown.options.tag as string).length).toBeLessThanOrEqual(64);
  }
});

test("an id-shaped notificationId becomes the tag, unchanged and untruncated", async () => {
  const worker_ = worker();
  await worker_.fire(
    "push",
    push({ text: () => JSON.stringify({ notificationId: " run:7_ab.c-1 " }) }),
  );
  expect(worker_.shown[0]!.options.tag).toBe("run:7_ab.c-1");

  const boundary = "n".repeat(64);
  await worker_.fire(
    "push",
    push({ text: () => JSON.stringify({ notificationId: boundary }) }),
  );
  expect(worker_.shown[1]!.options.tag).toBe(boundary);

  await worker_.fire(
    "push",
    push({ text: () => JSON.stringify({ notificationId: `${boundary}x` }) }),
  );
  expect(worker_.shown[2]!.options.tag).toBe("ownbot");
});

test("a click focuses an own tab of the app rather than trusting anything in the payload", async () => {
  const worker_ = worker([{ url: "https://ownbot.example/bot?agent=coord" }]);
  await worker_.fire(
    "push",
    push({ text: () => JSON.stringify({ notificationId: "run-7" }) }),
  );
  await worker_.fire("notificationclick", {
    notification: { tag: "run-7" },
    action: "https://evil.example/phishing",
  });

  expect(worker_.counts.closed).toBe(1);
  expect(worker_.opened).toEqual([]);
  expect(worker_.windowStates[0]!.navigated).toEqual([
    "https://ownbot.example/notifications",
  ]);
  expect(worker_.windowStates[0]!.focused).toBe(1);
});

test("without an own tab a click opens /notifications on our own origin, and never a foreign window", async () => {
  const focusedOnly = worker([
    { url: "https://ownbot.example/notifications", canNavigate: false },
  ]);
  await focusedOnly.fire("notificationclick", {
    notification: { tag: "run-7" },
  });
  expect(focusedOnly.windowStates[0]!.navigated).toEqual([]);
  expect(focusedOnly.windowStates[0]!.focused).toBe(1);
  expect(focusedOnly.opened).toEqual([]);

  const foreign = worker([{ url: "https://evil.example/ownbot" }]);
  await foreign.fire("notificationclick", {
    notification: { tag: "run-7" },
    action: "https://evil.example/phishing",
  });
  expect(foreign.windowStates[0]!.focused).toBe(0);
  expect(foreign.opened).toEqual(["https://ownbot.example/notifications"]);
});
