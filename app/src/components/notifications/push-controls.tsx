import { useCallback, useEffect, useRef, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";

/**
 * Web Push controls for one device.
 *
 * WHAT THIS IS FOR. The inbox at `/notifications` is the record; a push message is only the nudge that
 * gets a person back to it. Enabling it is a per-browser decision — the subscription belongs to this
 * device and this browser profile, and the server stores it against whoever is signed in. So this
 * component has to answer two different questions separately, and say them differently:
 *
 * - *Does this browser hold a subscription?* Local fact, read from the service worker registration.
 * - *Is that subscription registered to the account you are signed into?* Server fact, and the only
 *   comparison available is the SHA-256 of the endpoint URL: the server publishes hashes
 *   (`subscriptions[].endpointHash`) rather than endpoints, so a person can confirm "this device is
 *   registered" without the endpoint — which is a capability to send them messages — ever leaving the
 *   browser. A hash that is not on the list means either "never registered" or "registered to another
 *   account", and the UI must not pretend to know which. That is also why an existing subscription this
 *   session did not create is never touched without an explicit click: unsubscribing it could silence
 *   another person's account on this browser, and silently re-registering it could move it.
 *
 * NOTHING HERE IS ENABLED EARLY. The state says "Ativado neste dispositivo" only when the server lists
 * the hash of the subscription this browser holds. A POST that failed leaves the button on "Ativar", and
 * the only subscription this click created is unsubscribed again so the browser does not keep a
 * registration the server knows nothing about.
 *
 * PERMISSION IS ASKED FOR ON A CLICK ONLY. `Notification.requestPermission()` is called inside the
 * activate handler below, never on mount and never from an effect: a request nobody asked for trains
 * people to dismiss dialogs without reading them, and a dismissed one is refused for good.
 */

const ENDPOINT_HASH_LENGTH = 64;

/** What `GET /api/notifications/push` answers under `push`. Hashes, never endpoints. */
export type PushSettings = {
  enabled: boolean;
  publicKey: string | null;
  subscriptions: { id: string; endpointHash: string }[];
};

/** Why push cannot be offered here, in the words the person needs rather than an error code. */
export type UnsupportedReason =
  /** No service worker, no PushManager, or no WebCrypto to hash the endpoint with. */
  | "no-push"
  /** Push requires a secure context; http on a tailnet address does not qualify. */
  | "insecure"
  /** iOS and iPadOS accept Web Push only for a home-screen install. */
  | "ios-not-installed";

export const pushSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["push", "settings"],
    // Its own key, not under ["notifications"], so marking an item read does not refetch this.
    queryFn: () =>
      client<PushSettings>("/api/notifications/push", "push", {
        fallback: "Não foi possível verificar os avisos deste dispositivo.",
      }),
  });

/**
 * Lowercase hex SHA-256 of the endpoint URL — the same value the server compares against.
 *
 * Exported because it is the boundary between "the browser's endpoint" and "what the server may be
 * shown"; it should never be handed anything but the endpoint itself.
 */
export async function endpointHash(endpoint: string): Promise<string> {
  if (!crypto?.subtle?.digest)
    throw new Error(
      "Este navegador não oferece WebCrypto para comparar assinaturas.",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const isAppleTabletOrPhone = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as MacIntel with touch.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

const isInstalledShell = () => {
  if (typeof window === "undefined") return false;
  const standalone = (window as { standalone?: boolean }).standalone;
  if (typeof standalone === "boolean") return standalone;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
};

/**
 * The container's `pushManager`, through the shape this component uses.
 *
 * The DOM library this app compiles against types `ServiceWorkerRegistration.pushManager` but not
 * `ServiceWorkerContainer.pushManager`, so the pre-flight probe reaches it structurally. The cast is the
 * width of the one call made below, and the value is only returned after a `"pushManager" in` test.
 */
type PushController = {
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey?: BufferSource | null;
  }): Promise<PushSubscription>;
};
const containerPushManager = (): PushController | undefined =>
  typeof ServiceWorkerContainer === "undefined" ||
  !("pushManager" in ServiceWorkerContainer.prototype)
    ? undefined
    : (navigator.serviceWorker as unknown as { pushManager?: PushController })
        .pushManager;

/**
 * Whether this browser can be offered push at all, before anyone clicks.
 *
 * Deliberately synchronous and side-effect free: no registration, no permission prompt, no request. The
 * iOS branch is checked before and after the capability probe on purpose — Safari 16.4+ exposes
 * `PushManager` in the browser but refuses `subscribe()` unless the site runs as a home-screen install,
 * so both "the API is missing" and "the API is there but will be refused" mean the same instruction.
 */
export function pushSupport():
  | { supported: true; reason?: undefined }
  | { supported: false; reason: UnsupportedReason } {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return { supported: false, reason: "no-push" };
  const appleWithoutInstall = isAppleTabletOrPhone() && !isInstalledShell();
  const hasPush =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    typeof containerPushManager()?.subscribe === "function" &&
    typeof crypto?.subtle?.digest === "function";
  if (!hasPush)
    return {
      supported: false,
      reason: appleWithoutInstall ? "ios-not-installed" : "no-push",
    };
  // `isSecureContext` is the answer when the browser exposes it; the address is the fallback.
  const secure =
    typeof window.isSecureContext === "boolean"
      ? window.isSecureContext
      : window.location.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  if (!secure) return { supported: false, reason: "insecure" };
  if (appleWithoutInstall)
    return { supported: false, reason: "ios-not-installed" };
  return { supported: true };
}

/** A VAPID key is a 65-byte uncompressed P-256 point in base64url. Anything else fails with `DataError`. */
function vapidKeyToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 65)
    throw new Error(
      "A chave de assinatura publicada por esta instalação não tem o formato esperado.",
    );
  return bytes;
}

const SERVICE_WORKER = "/ownbot-push-sw.js";

/**
 * Registering is done on the way to subscribing, never on mount.
 *
 * A registration on its own is a standing process the person did not ask for and a scope claim over
 * `/`. It happens here only after a click, in a supported secure context, and the file it registers has
 * no `fetch` handler and no cache.
 */
async function registerWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration) return registration;
  return navigator.serviceWorker.register(SERVICE_WORKER, { scope: "/" });
}

type DeviceState =
  /** Not looked at yet, or the browser cannot register a worker. */
  | { phase: "unknown"; endpoint: null }
  /** This browser holds a subscription; `registered` is the server's answer, not an assumption. */
  | { phase: "held"; endpoint: string; registered: boolean };

export function PushNotificationControls() {
  const queryClient = useQueryClient();
  const settings = useQuery(pushSettingsQueryOptions());
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === "undefined" ? null : Notification.permission,
  );
  const [device, setDevice] = useState<DeviceState>({
    phase: "unknown",
    endpoint: null,
  });
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  const support = pushSupport();
  const registeredHashes = new Set(
    (settings.data?.subscriptions ?? [])
      .map((row) => (row.endpointHash ?? "").toLowerCase())
      // A hash of the wrong length is not a hash; comparing it would match nothing but also lie.
      .filter((hash) => hash.length === ENDPOINT_HASH_LENGTH),
  );

  /*
   * Read what this browser already holds. Only in a supported context, and via `getRegistration`, which
   * answers at once — `serviceWorker.ready` can stay pending forever when a worker never activates, and
   * a pending read would leave the panel showing nothing.
   */
  useEffect(() => {
    mounted.current = true;
    if (!support.supported) return () => {};
    let cancelled = false;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription =
          await registration?.pushManager?.getSubscription?.();
        if (cancelled || !subscription?.endpoint) return;
        const hash = await endpointHash(subscription.endpoint).catch(
          () => null,
        );
        if (cancelled) return;
        setDevice({
          phase: "held",
          endpoint: subscription.endpoint,
          registered: false,
        });
        setLocalHash(hash);
      } catch {
        // A browser that will not answer is reported by the button staying on "Ativar".
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [support.supported]);

  // The server owns the answer to "is this registered", so the match is recomputed, never assumed.
  const registered =
    device.phase === "held" &&
    localHash !== null &&
    registeredHashes.has(localHash);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["push", "settings"] });
  }, [queryClient]);

  const enable = useCallback(async () => {
    if (!support.supported || busy) return;
    setBusy("enable");
    setNotice(null);
    try {
      const granted = await Notification.requestPermission();
      if (!mounted.current) return;
      setPermission(granted);
      if (granted !== "granted") {
        setNotice(
          "O navegador não permitiu avisos para este site. Nada foi registrado.",
        );
        return;
      }
      if (!settings.data?.enabled) {
        setNotice(
          "O envio de avisos pelo navegador está desativado nesta instalação.",
        );
        return;
      }
      if (!settings.data.publicKey) {
        setNotice(
          "O serviço de avisos ainda não está disponível. Tente novamente mais tarde.",
        );
        return;
      }
      const registration = await registerWorker();
      const held = await registration.pushManager.getSubscription();
      // A subscription this session did not create is never reposted or removed here.
      if (held?.endpoint) {
        if (!mounted.current) return;
        setDevice({
          phase: "held",
          endpoint: held.endpoint,
          registered: false,
        });
        setNotice(
          "Este navegador já guarda uma inscrição que não está registrada na sua conta. Desative este navegador e ative de novo para criar uma inscrição nova.",
        );
        return;
      }
      const created = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBytes(settings.data.publicKey),
      });
      if (!mounted.current) {
        // The person navigated away mid-flow: do not leave a half-registered subscription behind.
        await created.unsubscribe().catch(() => {});
        return;
      }
      setDevice({
        phase: "held",
        endpoint: created.endpoint,
        registered: false,
      });
      setLocalHash(await endpointHash(created.endpoint).catch(() => null));
      try {
        await client("/api/notifications/push/subscriptions", {
          method: "POST",
          body: created.toJSON(),
          fallback: "Não foi possível registrar este dispositivo para avisos.",
        });
      } catch (error) {
        // Undo only the subscription this click created, so the browser does not hold a registration
        // the server knows nothing about. An older one stays exactly where it is.
        await created.unsubscribe().catch(() => {});
        if (!mounted.current) return;
        setDevice({ phase: "unknown", endpoint: null });
        setLocalHash(null);
        throw error;
      }
      if (!mounted.current) return;
      setDevice({
        phase: "held",
        endpoint: created.endpoint,
        registered: true,
      });
      refresh();
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error && error.message
            ? error.message
            : "Não foi possível ativar avisos neste dispositivo.",
        );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, refresh, settings.data, support.supported]);

  /*
   * Explicit disable: the server first, so the endpoint stops being used even if this tab dies before
   * the browser call, then the browser's own subscription. Both name the same endpoint, and the
   * endpoint never leaves the browser except to the endpoint that owns it.
   */
  const disable = useCallback(async () => {
    if (busy || device.phase !== "held") return;
    const endpoint = device.endpoint;
    setBusy("disable");
    setNotice(null);
    try {
      await client("/api/notifications/push/subscriptions", {
        method: "DELETE",
        body: { endpoint },
        fallback: "Não foi possível desativar avisos neste dispositivo.",
      });
      const registration = await navigator.serviceWorker.getRegistration("/");
      const held = await registration?.pushManager?.getSubscription?.();
      if (held?.endpoint === endpoint) await held.unsubscribe();
      if (!mounted.current) return;
      setDevice({ phase: "unknown", endpoint: null });
      setLocalHash(null);
      refresh();
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error && error.message
            ? error.message
            : "Não foi possível desativar avisos neste dispositivo.",
        );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [busy, device, refresh]);

  /*
   * One button, three jobs, named by the state rather than by a click counter: turn push on, turn it
   * off, or remove a subscription this session did not create so the account now signed in can make its
   * own. `busy` keeps the primary button on screen and labelled through the flow, so an enable that is
   * still in flight does not swap the panel out from under the person who pressed it.
   */
  const blocked =
    !support.supported ||
    settings.isPending ||
    settings.isError ||
    permission === "denied";
  const action: "enable" | "disable" | "regrant" =
    busy !== null
      ? busy
      : registered
        ? "disable"
        : device.phase === "held"
          ? "regrant"
          : "enable";

  /**
   * The live region's sentence, and only a fact that is true at the moment it is read. "Ativado" comes
   * from the server's list, never from the browser holding a subscription, so a POST that has not landed
   * cannot be read as a working delivery path.
   */
  const stateLine =
    busy === "enable"
      ? "Criando a inscrição neste navegador e registrando-a no ownbot…"
      : busy === "disable"
        ? "Removendo a inscrição deste navegador e do ownbot…"
        : !support.supported
          ? "Este navegador não pode receber avisos do ownbot agora."
          : permission === "denied"
            ? "O navegador bloqueou avisos para este site. Siga os passos abaixo para liberar."
            : settings.isPending
              ? "Verificando o registro deste dispositivo no ownbot…"
              : registered
                ? "Este navegador está registrado para receber avisos da conta em que você está."
                : device.phase === "held"
                  ? "Este navegador guarda uma inscrição que o ownbot não reconhece como sua. Ela pode pertencer a outra conta usada neste navegador; o ownbot não a remove nem a re-registra sem um clique seu."
                  : "Nenhum aviso ativado neste navegador ainda.";

  const instructions: string[] = [];
  if (!support.supported) {
    if (support.reason === "ios-not-installed")
      instructions.push(
        "No iPhone ou no iPad, o Safari só aceita avisos da web quando o ownbot está instalado: toque no ícone de compartilhar e escolha “Adicionar à Tela de Início”. Depois abra o ownbot por esse ícone e ative aqui.",
        "É preciso iOS 16.4 ou mais novo.",
      );
    if (support.reason === "insecure")
      instructions.push(
        "Avisos da web exigem HTTPS (ou localhost). Abra este endereço por HTTPS e recarregue a página.",
      );
    if (support.reason === "no-push")
      instructions.push(
        "Este navegador não oferece avisos. Abra o ownbot em um navegador compatível ou pelo aplicativo adicionado à Tela de Início.",
      );
  }
  if (support.supported && permission === "denied")
    instructions.push(
      "O navegador bloqueou avisos para este site. No Chrome e no Edge, toque no cadeado da barra de endereço › Configurações do site › Notificações › Perguntar. No iPhone, abra Ajustes › ownbot › Notificações e permita. Depois recarregue esta página.",
    );

  return (
    <section
      aria-labelledby="push-controls-title"
      className="rounded-xl border p-4 sm:p-5 space-y-3 min-w-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="push-controls-title" className="font-medium">
          Avisos neste dispositivo
        </h2>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${
            registered
              ? "border-primary/50 text-primary"
              : "border-input text-muted-foreground"
          }`}
        >
          {busy === "enable"
            ? "Registrando neste dispositivo…"
            : busy === "disable"
              ? "Desativando…"
              : settings.isPending
                ? "Verificando este dispositivo…"
                : registered
                  ? "Ativado neste dispositivo"
                  : device.phase === "held"
                    ? "Inscrição do navegador sem registro no ownbot"
                    : "Desativado neste dispositivo"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Os avisos são entregues pelo serviço de push do navegador — Chrome,
        Edge, Firefox, ou o ownbot instalado no iPhone. O recado enviado é
        genérico: título ownbot e uma linha dizendo que há uma nova atualização
        no seu projeto. Títulos, textos e detalhes ficam apenas dentro do
        ownbot, depois de entrar na sua conta.
      </p>

      {settings.isError && (
        <p role="alert" className="text-sm text-destructive">
          {settings.error instanceof Error
            ? settings.error.message
            : "Não foi possível verificar os avisos deste dispositivo."}{" "}
          <Button variant="outline" size="sm" onClick={refresh}>
            Tentar novamente
          </Button>
        </p>
      )}
      {settings.isSuccess && !settings.data.enabled && (
        <p className="text-sm text-muted-foreground">
          O envio de avisos pelo navegador está desativado pelo operador desta
          instalação. Não há nada para ativar aqui.
        </p>
      )}
      {settings.isSuccess &&
        settings.data.enabled &&
        !settings.data.publicKey && (
          <p className="text-sm text-muted-foreground">
            O serviço de avisos ainda não está disponível. Tente novamente mais tarde.
          </p>
        )}

      <p role="status" aria-live="polite" className="text-sm">
        {stateLine}
        {notice ? ` ${notice}` : ""}
      </p>

      {instructions.length > 0 && (
        <ul className="text-sm text-muted-foreground list-disc space-y-1 pl-5">
          {instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {action === "regrant" ? (
          /*
           * Not an enable button. The subscription this browser holds is not this account's to repost,
           * and removing it can silence another account on this device, so it gets its own click and no
           * help from the app.
           */
          <Button
            variant="outline"
            onClick={() => void disable()}
            disabled={busy !== null}
          >
            {busy === "disable" ? "Desativando…" : "Desativar este navegador"}
          </Button>
        ) : (
          <Button
            onClick={() => void (action === "enable" ? enable() : disable())}
            disabled={busy !== null || (action === "enable" && (blocked || !settings.data?.enabled || !settings.data.publicKey))}
            aria-busy={busy !== null}
          >
            {action === "enable"
              ? busy === "enable"
                ? "Ativando avisos neste dispositivo…"
                : "Ativar avisos neste dispositivo"
              : busy === "disable"
                ? "Desativando…"
                : "Desativar avisos neste dispositivo"}
          </Button>
        )}
      </div>
      {!support.supported && (
        <p className="text-xs text-muted-foreground">
          O botão fica desativado enquanto o navegador não puder receber avisos.
          Nenhuma permissão é pedida automaticamente.
        </p>
      )}
    </section>
  );
}
