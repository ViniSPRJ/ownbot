import { useQuery } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
type Health = { status: "ready" | "degraded"; checks: Record<string, boolean> };
export function WorkerHealth() {
  const query = useQuery({ queryKey: ["worker-health"], refetchInterval: 30000, queryFn: async (): Promise<Health> => {
    const response = await tryClient("/api/operations/health");
    const value = await response.json();
    if (![200,503].includes(response.status) || !value || typeof value.checks !== "object") throw new Error("Health unavailable");
    return value;
  } });
  const labels: Record<string,string> = {database:"Banco de dados",scheduler:"Worker de rotinas",notifications:"Notificações",history:"Histórico local",runs:"Execuções sem atraso"};
  return <section className="rounded-lg border p-4 space-y-2" aria-label="Saúde da operação">
    <h2 className="font-semibold">Saúde da operação</h2>
    {query.isPending ? <p>Verificando…</p> : query.error ? <p role="alert">Não foi possível verificar os serviços. A conexão ou a API pode estar indisponível.</p> : <>
      <p role={query.data.status === "ready" ? "status" : "alert"}>{query.data.status === "ready" ? "Serviços operacionais" : "Atenção: serviço indisponível ou trabalho atrasado"}</p>
      <ul className="text-sm">{Object.entries(query.data.checks).map(([name,ok]) => <li key={name}>{labels[name] ?? name}: {ok ? "OK" : "Requer atenção"}</li>)}</ul>
      <p className="text-xs text-muted-foreground">Verificação automática a cada 30 segundos. Não confirma disponibilidade de todos os modelos ou fontes.</p>
    </>}
  </section>;
}
