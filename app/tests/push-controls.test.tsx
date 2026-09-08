import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setTimeout as delay } from "node:timers/promises";
import { PushNotificationControls, endpointHash } from "@/components/notifications/push-controls";

beforeAll(() => GlobalRegistrator.register({ url: "https://ownbot.example/notifications" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test.each([false, true])("standard browser subscribes in the click and trusts the server result (POST fails: %s)", async serverFailure => {
  let gesture = false;
  const subscriptionGestures: boolean[] = [];
  const requests: string[] = [];
  const endpoint = "https://web.push.apple.com/test-fixture";
  const hash = await endpointHash(endpoint);
  let saved = false;
  let unsubscribed = 0;
  const priorNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  class Notification { static permission = "default"; }
  class PushManager {
    async getSubscription() { return null; }
    subscribe() {
      subscriptionGestures.push(gesture);
      Notification.permission = "granted";
      return Promise.resolve({ endpoint, unsubscribe: async () => { unsubscribed++; return true; }, toJSON: () => ({ endpoint, keys: { p256dh: "fixture", auth: "fixture" } }) });
    }
  }
  class Registration extends EventTarget {
    get pushManager() { return new PushManager(); }
    active = { state: "activated", scriptURL: "https://ownbot.example/ownbot-push-sw.js" };
  }
  const registration = new Registration();
  for (const [name, value] of Object.entries({ Notification, PushManager, ServiceWorkerRegistration: Registration, isSecureContext: true }))
    Object.defineProperty(window, name, { configurable: true, value });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: Notification });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: async () => registration,
  } });
  const settings = () => ({ enabled: true, publicKey: "B" + "A".repeat(86), subscriptions: saved ? [{ id: "fixture", endpointHash: hash }] : [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  queryClient.setQueryData(["push", "settings"], settings());
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    requests.push(`${options?.method ?? "GET"} ${url}`);
    if (options?.method === "POST") {
      if (serverFailure) return Response.json({ error: "Registro indisponível" }, { status: 503 });
      saved = true; return Response.json({ ok: true, id: "fixture" });
    }
    return Response.json({ push: settings() });
  });
  try {
    const view = render(<QueryClientProvider client={queryClient}><PushNotificationControls /></QueryClientProvider>);
    await act(async () => { await delay(25); });
    const button = view.getByRole("button", { name: "Ativar avisos neste dispositivo" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(subscriptionGestures).toEqual([]);
    expect(requests).toEqual([]);
    gesture = true;
    act(() => { fireEvent.click(button); });
    gesture = false;
    expect(subscriptionGestures).toEqual([true]);
    await act(async () => { await delay(40); });
    expect(requests).toContain("POST /api/notifications/push/subscriptions");
    if (serverFailure) {
      expect(view.queryByText("Ativado neste dispositivo")).toBeNull();
      expect(view.getByRole("button", { name: "Desativar este navegador" })).toBeTruthy();
    } else expect(view.getByText("Ativado neste dispositivo")).toBeTruthy();
    expect(unsubscribed).toBe(0);
  } finally {
    fetch.mockRestore(); queryClient.clear();
    if (priorNotification) Object.defineProperty(globalThis, "Notification", priorNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
  }
});
