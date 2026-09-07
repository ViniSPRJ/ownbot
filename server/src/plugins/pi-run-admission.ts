/** Ownbot's MCP request window is shorter than local reasoning. Submit durable work first. */
export function piRunAdmissionRefusal(
  ref: string,
  args: Record<string, unknown>,
): string | null {
  if (ref !== "pi-m4/pi_run" && ref !== "pi-m5/pi_run") return null;
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
  return "Para executar no Pi pelo ownbot, envie background:true e idempotencyKey estável (1–256 caracteres, sem quebra de linha). Reenvie a mesma tarefa com a mesma chave nas tentativas; não crie outra tarefa. Depois acompanhe pi_status com o jobId retornado.";
}
