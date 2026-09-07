import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import {
  executionQuery,
  executionStatus,
  runNotificationStatus,
} from "@/lib/routines/executions";
export const Route = createFileRoute("/_authed/_app/routine-runs/$runId")({
  component: ExecutionPage,
});
function ExecutionPage() {
  const { runId } = Route.useParams();
  const query = useQuery(executionQuery(runId));
  const run = query.data;
  return (
    <PageShell
      title="Resultado da execução"
      description="Resultado persistido desta execução e situação da notificação."
    >
      {query.isPending ? (
        <p>Carregando…</p>
      ) : query.error ? (
        <p role="alert">
          A execução não foi encontrada ou não está disponível para você.
        </p>
      ) : run ? (
        <div className="space-y-4">
          <p>
            {executionStatus(run)} · {runNotificationStatus(run)}
          </p>
          <p className="text-sm text-muted-foreground">
            {new Date(run.startedAt).toLocaleString("pt-BR")} · {run.agentId}
          </p>
          <Link
            className="underline"
            to="/channel/$channelId"
            params={{ channelId: run.channelId }}
          >
            Abrir canal {run.channelName ?? ""}
          </Link>
          {run.error ? (
            <p className="whitespace-pre-wrap text-destructive">{run.error}</p>
          ) : null}
          <div className="whitespace-pre-wrap break-words rounded-lg border p-4">
            {run.replyText ?? "Esta execução não registrou uma resposta."}
          </div>
          <details>
            <summary>Instrução</summary>
            <p className="whitespace-pre-wrap">{run.instruction}</p>
          </details>
          <p className="text-xs text-muted-foreground">Execução {run.id}</p>
        </div>
      ) : null}
    </PageShell>
  );
}
