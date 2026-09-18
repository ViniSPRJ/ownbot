import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  executionStatus,
  executionsQuery,
  handoffStatus,
  handoffsQuery,
  piDelegationStatus,
  piDelegationsQuery,
  piWatchAttemptsLabel,
  runNotificationStatus,
} from "@/lib/routines/executions";
import { WorkerHealth } from "./worker-health";
export function Executions() {
  const runs = useQuery(executionsQuery());
  const handoffs = useQuery(handoffsQuery());
  const piDelegations = useQuery(piDelegationsQuery());
  return (
    <section className="mt-8 space-y-4">
      <WorkerHealth />
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
            {executionStatus(run)} · {runNotificationStatus(run)}
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
          <span>{handoffStatus(hop)}</span>
          <span className="text-muted-foreground">
            {" "}
            · {new Date(hop.at).toLocaleString("pt-BR")}
          </span>
        </div>
      ))}
      <h2 className="font-semibold pt-4">Acompanhamentos Pi recentes</h2>
      <p className="text-sm text-muted-foreground">
        O acompanhamento consulta o status do trabalho no executor. O
        encerramento do acompanhamento e o resultado do trabalho no executor
        são verificados separadamente. Concluído no executor não confirma a
        entrega da resposta ao agente solicitante.
      </p>
      {piDelegations.error ? (
        <p role="alert">Não foi possível ler os acompanhamentos Pi.</p>
      ) : null}
      {piDelegations.isSuccess && !piDelegations.data.length ? (
        <p className="text-sm">Nenhum acompanhamento Pi registrado.</p>
      ) : null}
      {piDelegations.data?.map((item, index) => (
        <article
          className="rounded-lg border p-4 space-y-2"
          key={item.key ?? item.jobId ?? index}
        >
          <p className="font-medium">
            {item.executor ?? "Executor desconhecido"}
            {item.jobId ? ` · ${item.jobId}` : ""}
          </p>
          <p className="text-sm">{piDelegationStatus(item)}</p>
          <p className="text-sm text-muted-foreground">
            {piWatchAttemptsLabel(item.attempts)}
            {item.createdAt
              ? ` · ${new Date(item.createdAt).toLocaleString("pt-BR")}`
              : item.runAt
                ? ` · ${new Date(item.runAt).toLocaleString("pt-BR")}`
                : ""}
          </p>
        </article>
      ))}
    </section>
  );
}
