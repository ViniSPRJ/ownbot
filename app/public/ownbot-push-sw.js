/*
 * ownbot Web Push service worker.
 *
 * Registered at scope `/` by `app/src/components/notifications/push-controls.tsx`, and only once the
 * browser is in a supported secure context. It does one job: turn a push message into one generic
 * notification.
 *
 * WHAT IT DOES NOT DO. There is no `fetch` listener and no `caches` use anywhere in this file, so it
 * cannot become a cache of the app, cannot rewrite a request, and cannot hold a signed-out copy of a
 * page. And it never opens a URL that came from the payload: the payload cannot choose a destination, so the only address it can send a person to is `/notifications` on our
 * own origin, which is where the inbox lives and where the account has to be signed in already.
 *
 * The payload is therefore treated as noise with one optional hint. Anything the payload claims —
 * titles, bodies, images, links — is ignored, because the push service is not a trusted channel and
 * because the notification must not carry private project content outside the app.
 */

/** What appears in the notification. Fixed text, no task detail, nothing the payload can change. */
const TITLE = "ownbot";
const BODY = "Há uma nova atualização no seu projeto.";
/** Where a click goes. A constant, never a value from the payload. */
const TARGET_PATH = "/notifications";
/**
 * Fallback tag, used when the payload carries no usable `notificationId`.
 *
 * A tag is what makes the push service replace a notification rather than stack another one. With a
 * fixed fallback, a burst of untagged messages leaves one notification on the screen instead of ten;
 * the inbox is the list, the notification is only the nudge.
 */
const FALLBACK_TAG = "ownbot";
/** Deliberately short: a tag is a correlation hint, not a place to put a run id and its context. */
const MAX_NOTIFICATION_ID_LENGTH = 64;
const NOTIFICATION_ID = /^[A-Za-z0-9._:-]+$/;

/**
 * The stable tag for a push message: its `notificationId` when that is a short, plain token.
 *
 * Everything else — absent, not a string, empty, longer than the bound, or holding anything but plain
 * token characters — falls back to the shared tag. A truncated id is not used, because two different
 * notifications truncated to the same characters would collapse into one another.
 */
function tagFor(raw) {
  if (typeof raw !== "string") return FALLBACK_TAG;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_NOTIFICATION_ID_LENGTH)
    return FALLBACK_TAG;
  if (!NOTIFICATION_ID.test(id)) return FALLBACK_TAG;
  return id;
}

self.addEventListener("install", () => {
  // Nothing to precache, so there is nothing to wait for.
  self.skipWaiting();
});

self.addEventListener("activate", () => {
  // Claim the open tabs so a registration made on this page is the one that receives pushes now,
  // rather than after the next navigation.
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  /*
   * Read only the hint, and only if the message even carries a body. `text()` throws on some engines
   * when the data is encrypted-but-empty, so it is guarded, and a parse failure is simply the case of
   * a payload with no hint.
   */
  let notificationId;
  const text = (() => {
    try {
      return typeof event.data?.text === "function" ? event.data.text() : "";
    } catch {
      return "";
    }
  })();
  if (text) {
    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === "object")
        notificationId = payload.notificationId;
    } catch {
      // Not JSON, or JSON that is not an object. The notification is still shown, generic.
    }
  }

  /*
   * Always shown. A malformed or empty payload is the normal case, not an error: the person gets the
   * same nudge and reads the real content in the app.
   */
  event.waitUntil(
    self.registration.showNotification(TITLE, {
      body: BODY,
      tag: tagFor(notificationId),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: "pt-BR",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = new URL(TARGET_PATH, self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: false,
      });
      for (const client of windows) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        // `navigate` is missing on some engines; focusing an own tab is still the right answer there.
        if (typeof client.navigate === "function") {
          const navigated = await client.navigate(target);
          await (navigated ?? client).focus();
        } else await client.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
