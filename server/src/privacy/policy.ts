/** Explicit trust domains; never guesses whether arbitrary prose contains a secret. */
export function isPrivateAgent(botId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENBOT_PRIVATE_AGENT_IDS ?? "").split(",").map(v => v.trim()).filter(Boolean).includes(botId);
}
export const PRIVATE_BOUNDARY = "Este bot mantém o contexto privado. Pesquisa pública e ferramentas externas devem ser usadas em uma conversa pública separada, sem copiar dados privados.";

/** A dedicated, operator-verified local server, never the default multi-provider proxy. */
export function privateModelRoute(env: NodeJS.ProcessEnv = process.env): { baseURL: string; model: string } {
  if (env.OPENBOT_SELF_HOSTED !== "true" || env.OPENBOT_PRIVATE_MODEL_VERIFIED !== "true" || env.OPENBOT_NOTIFICATION_DELIVERY !== "internal")
    throw new Error("O processamento privado aguarda a validação do modelo e do histórico locais.");
  const model = env.OPENBOT_PRIVATE_MODEL?.trim();
  const raw = env.OPENBOT_PRIVATE_MODEL_BASE_URL?.trim();
  if (!model || !raw) throw new Error("O modelo local privado não foi configurado.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Endereço do modelo privado inválido."); }
  const h = url.hostname;
  const octets = h.split(".").map(Number);
  const tailnet = octets.length === 4 && octets.every(v => Number.isInteger(v) && v >= 0 && v <= 255) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    !(h === "127.0.0.1" || h === "localhost" || h === "[::1]" || tailnet))
    throw new Error("O modelo privado exige endereço loopback ou IP da Tailnet, sem credenciais na URL.");
  return { baseURL: url.toString().replace(/\/$/, ""), model };
}

export function privateModelFetch(baseURL: string, send: typeof fetch = fetch): typeof fetch {
  const base = new URL(baseURL);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== base.origin || url.pathname !== `${base.pathname.replace(/\/$/, "")}/chat/completions`)
      throw new Error("Destino fora do modelo privado recusado.");
    const response = await send(input, { ...init, redirect: "error" });
    if (response.status >= 300 && response.status < 400) throw new Error("Redirecionamento do modelo privado recusado.");
    return response;
  }) as typeof fetch;
}
