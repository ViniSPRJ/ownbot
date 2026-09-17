import {
  DEFAULT_DURABLE_EXECUTORS,
  type DurableExecutorRegistry,
} from "../agents/durable-executors";

const UNREGISTERED_PI_RUN_REFUSAL =
  "Executor not registered. Unregistered */pi_run tools are refused and are not run synchronously.";

/** Ownbot's MCP request window is shorter than local reasoning. Submit durable work first. */
export function piRunAdmissionRefusal(
  ref: string,
  args: Record<string, unknown>,
  executors: DurableExecutorRegistry = DEFAULT_DURABLE_EXECUTORS,
): string | null {
  const executor = executors.findBySubmitTool(ref);
  if (!executor) {
    // Deny-only: an unregistered */pi_run must not fall through to ordinary
    // sync MCP. Removing a registration must not turn former durable work
    // into an untracked synchronous call. This suffix is never an allow list.
    if (ref.endsWith("/pi_run")) return UNREGISTERED_PI_RUN_REFUSAL;
    return null;
  }
  const key = args.idempotencyKey;
  if (
    args.background === true &&
    typeof key === "string" &&
    key.trim().length > 0 &&
    key.length <= 256 &&
    !/[\0\r\n]/.test(key)
  ) {
    return null;
  }
  return `Para executar no Pi pelo ownbot, envie background:true e idempotencyKey estável (1–256 caracteres, sem quebra de linha). Reenvie a mesma tarefa com a mesma chave nas tentativas; não crie outra tarefa. Depois acompanhe ${executor.statusTool} com o jobId retornado.`;
}
