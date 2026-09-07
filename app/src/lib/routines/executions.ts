import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
export type Execution = {
  id: string;
  routineId: string;
  agentId: string;
  channelId: string;
  channelName: string | null;
  instruction: string;
  status: string | null;
  scheduledFor: string | null;
  startedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  replyText: string | null;
  error: string | null;
  notificationStatus: string | null;
  notificationAttempts: number | null;
  deliveredAt: string | null;
  internalNotificationAvailable?: boolean;
  notificationDelivery?: "internal" | "telegram";
};
export type Handoff = {
  id: string;
  event: string;
  at: string;
  from: string | null;
  to: string | null;
  run: string | null;
  workKey: string | null;
  resultAvailable?: boolean | null;
  returnQueued?: boolean | null;
  isReturn?: boolean | null;
};
export function executionQuery(id?: string) {
  return queryOptions({
    queryKey: ["routines", "execution", id],
    enabled: !!id,
    queryFn: (): Promise<Execution> =>
      client(`/api/operations/runs/${encodeURIComponent(id ?? "")}`, "run", {
        fallback: "Execution could not be loaded.",
      }),
    refetchInterval: 15_000,
  });
}
export function executionsQuery() {
  return queryOptions({
    queryKey: ["routines", "executions"],
    queryFn: (): Promise<Execution[]> =>
      client("/api/operations/runs", "runs", {
        fallback: "Executions could not be loaded.",
      }),
    refetchInterval: 15_000,
  });
}
export function handoffsQuery() {
  return queryOptions({
    queryKey: ["routines", "handoffs"],
    queryFn: (): Promise<Handoff[]> =>
      client("/api/operations/handoffs", "handoffs", {
        fallback: "Delegations could not be loaded.",
      }),
    refetchInterval: 15_000,
  });
}
export function executionStatus(run: Execution): string {
  return run.status === "succeeded"
    ? "Concluída"
    : run.status === "failed"
      ? "Falhou"
      : run.status === "skipped"
        ? "Não concluída — ver motivo"
        : run.status !== null || run.finishedAt
          ? "Estado desconhecido"
          : run.claimedAt
            ? "Em execução"
            : "Aguardando execução";
}
export function deliveryStatus(status: string | null): string {
  return (
    (
      {
        pending: "Aguardando envio",
        sending: "Enviando",
        sent: "Entrega confirmada pelo notificador",
        failed: "Falha no envio",
      } as Record<string, string>
    )[status ?? ""] ?? "Sem registro de envio"
  );
}

export function handoffStatus(hop: Handoff): string {
  if (hop.event === "agent.handoff_delivered") {
    if (hop.isReturn === true) return "Retorno processado pelo solicitante";
    if (hop.returnQueued === true) return "Resposta salva; retorno enfileirado";
    if (hop.resultAvailable === true) return "Resposta salva";
    return "Processada pelo destinatário; retorno não confirmado";
  }
  return (
    (
      {
        "agent.handoff_offered": "Enfileirada",
        "agent.handoff_failed": "Falhou",
        "agent.handoff_retried": "Nova tentativa",
        "agent.handoff_refused": "Não enviada",
      } as Record<string, string>
    )[hop.event] ?? "Estado desconhecido"
  );
}

export function runNotificationStatus(run: Execution): string {
  if (run.notificationDelivery === "internal")
    return run.internalNotificationAvailable
      ? "Notificação interna disponível"
      : run.finishedAt
        ? "Notificação interna pendente"
        : "Notificação após a conclusão";
  return `Telegram: ${deliveryStatus(run.notificationStatus)}`;
}
