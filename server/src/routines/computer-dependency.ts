import type { ComputerProvider } from "../computer/provider";

export class ComputerDependencyError extends Error {
  constructor(readonly draft?: string, readonly resultMessageId?: string) {
    super("infrastructure_computer_unavailable: serviço de navegador indisponível; cobertura web não concluída. Incidente registrado nesta execução, sem replay automático.");
    this.name = "ComputerDependencyError";
  }
}

/** Readiness never calls locate/ensure: checking health must not boot a Bot's computer. */
export async function computerReady(provider: ComputerProvider, botId = "news"): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      provider.status(botId),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("computer probe deadline")), 5000); }),
    ]);
    return status.state === "ready" || (provider.isolation === "per-bot" && status.state === "absent");
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function routineComputerPreflight(provider: ComputerProvider | undefined,
  required = (process.env.ROUTINE_COMPUTER_REQUIRED_AGENTS ?? "news").split(",").map(id => id.trim()).filter(Boolean)) {
  const agents = new Set(required);
  return async ({ agentId }: { agentId: string }) => {
    if (!agents.has(agentId)) return;
    if (!provider || !await computerReady(provider, agentId)) throw new ComputerDependencyError();
    // Per-bot providers may start lazily on the first governed tool call. Shared service must
    // already be reachable. This check does not grant shell access or bypass action policies.
  };
}
