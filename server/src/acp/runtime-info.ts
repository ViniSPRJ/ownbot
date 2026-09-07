import { acpProfileFor } from "./config";
import { isPrivateAgent } from "../privacy/policy";

/** Public execution description. Configuration is not a health or login assertion. */
export function agentRuntimeInfo(agentId: string, builtIn: boolean) {
  if (isPrivateAgent(agentId)) return { kind: "private_local", label: "Modelo local privado" } as const;
  try {
    const profile = acpProfileFor(agentId);
    if (!profile) return builtIn
      ? { kind: "api", label: "Modelo via API" } as const
      : { kind: "remote", label: "Agente externo" } as const;
    const provider = profile.provider ?? "codex";
    const names = { codex: "Codex CLI", claude: "Claude Code", grok: "Grok Build" };
    return { kind: "acp", provider, label: `${names[provider]} · ACP` } as const;
  } catch {
    return { kind: "unavailable", label: "Configuração ACP indisponível" } as const;
  }
}
