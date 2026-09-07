import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { agentKeys } from "@/lib/agents/queries";

type Selection = {
  models: { id: string; name: string }[];
  currentModel: string | null;
  defaultModel: string | null;
  selectedModel: string | null;
  revision: string;
};

export function AcpModelSelector({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const key = ["agents", "acp-models", agentId];
  const path = `/api/agents/${encodeURIComponent(agentId)}/acp-models`;
  const query = useQuery({
    queryKey: key,
    queryFn: () => client<Selection>(path, "selection"),
    retry: false,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (model: string | null) =>
      client(path, {
        method: "PUT",
        body: { model, revision: query.data?.revision },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: () => {
      void query.refetch();
    },
  });
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Consultando modelos da CLI…
      </p>
    );
  if (query.error || !query.data)
    return (
      <div className="grid gap-2">
        <p className="text-sm text-destructive" role="alert">
          {query.error?.message ?? "Não foi possível consultar os modelos."}
        </p>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  const data = query.data;
  const selected = draft ?? data.selectedModel ?? "";
  const unavailable =
    selected && !data.models.some((model) => model.id === selected);
  return (
    <section className="grid gap-3">
      <label className="text-sm font-medium" htmlFor={`acp-model-${agentId}`}>
        Modelo deste agente
      </label>
      <select
        id={`acp-model-${agentId}`}
        className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
        value={selected}
        disabled={
          save.isPending || query.isFetching || data.models.length === 0
        }
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      >
        <option value="">
          Padrão da conexão
          {data.defaultModel || data.currentModel
            ? ` (${data.defaultModel ?? data.currentModel})`
            : ""}
        </option>
        {unavailable ? (
          <option value={selected}>Indisponível: {selected}</option>
        ) : null}
        {data.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <p className="text-sm text-muted-foreground">
        A escolha vale para as próximas tarefas, conversas e rotinas deste
        agente. Outros agentes que usam a mesma CLI mantêm seus próprios
        modelos.
      </p>
      {data.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Esta CLI não disponibilizou um seletor de modelos.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            save.isPending || draft === undefined || Boolean(unavailable)
          }
          onClick={() => save.mutate(selected || null)}
        >
          {save.isPending ? "Salvando…" : "Salvar modelo"}
        </Button>
        <Button
          variant="outline"
          disabled={query.isFetching || save.isPending}
          onClick={() => {
            setDraft(undefined);
            setSaved(false);
            void query.refetch();
          }}
        >
          Atualizar modelos
        </Button>
      </div>
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Modelo salvo para este agente.
        </p>
      ) : null}
    </section>
  );
}
