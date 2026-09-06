import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  executionsQuery,
  handoffsQuery,
  executionStatus,
  deliveryStatus,
} from "@/lib/routines/executions";
export function Executions() {
  const runs = useQuery(executionsQuery());
  const handoffs = useQuery(handoffsQuery());
  return (
    <section className="mt-8 space-y-4">
      <h2 className="font-semibold">Execuções recentes</h2>
      <p className="text-sm text-muted-foreground">
        A conclusão da tarefa e a entrega da notificação são verificadas
        separadamente.
      </p>
      {runs.error ? (
        <p role="alert">Não foi possível ler as execuções.</p>
      ) : null}
      {runs.isSuccess && !runs.data.length ? (
        <p className="text-sm">Nenhuma execução registrada.</p>
      ) : null}
      {runs.data?.map((run) => (
        <article className="rounded-lg border p-4 space-y-2" key={run.id}>
          <Link
            className="font-medium underline"
            to="/routine-runs/$runId"
            params={{ runId: run.id }}
          >
            {run.channelName ?? run.agentId} ·{" "}
            {new Date(run.startedAt).toLocaleString("pt-BR")}
          </Link>
          <p className="text-sm">
            {executionStatus(run)} · Telegram:{" "}
            {deliveryStatus(run.notificationStatus)}
          </p>
          {run.error ? (
            <p className="text-sm text-destructive whitespace-pre-wrap">
              {run.error}
            </p>
          ) : null}
        </article>
      ))}
      <h2 className="font-semibold pt-4">Delegações recentes</h2>
      {handoffs.error ? (
        <p role="alert">Não foi possível ler as delegações.</p>
      ) : null}
      {handoffs.isSuccess && !handoffs.data.length ? (
        <p className="text-sm">Nenhuma delegação registrada.</p>
      ) : null}
      {handoffs.data?.map((hop) => (
        <div className="text-sm border-b pb-2" key={hop.id}>
          <span>
            {hop.from ?? "Bot"} → {hop.to ?? "Bot"}:{" "}
          </span>
          <span>
            {(
              {
                "agent.handoff_offered": "Enfileirada",
                "agent.handoff_delivered":
                  "Processada pelo destinatário; retorno não confirmado",
                "agent.handoff_failed": "Falhou",
                "agent.handoff_retried": "Nova tentativa",
                "agent.handoff_refused": "Não enviada",
              } as Record<string, string>
            )[hop.event] ?? "Estado desconhecido"}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {new Date(hop.at).toLocaleString("pt-BR")}
          </span>
        </div>
      ))}
    </section>
  );
}
