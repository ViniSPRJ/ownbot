import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { agentKeys } from "@/lib/agents/queries";
import { AcpModelSelector } from "./acp-model-selector";

type Provider = "codex" | "claude" | "grok" | "pi";
type Selection = {
  profileId: string;
  profiles: { id: string; provider: Provider }[];
  revision: string;
};
const names: Record<Provider, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  grok: "Grok Build",
  pi: "Pi · modelos locais",
};

export function AcpProviderSelector({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState(false);
  const path = `/api/agents/${encodeURIComponent(agentId)}/acp-providers`;
  const query = useQuery({
    queryKey: ["agents", "acp-providers", agentId],
    queryFn: () => client<Selection>(path, "selection"),
    retry: false,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (profileId: string) =>
      client(path, {
        method: "PUT",
        body: { profileId, revision: query.data?.revision },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      setDraft(undefined);
      setSaved(true);
    },
    onError: () => {
      void query.refetch();
    },
  });
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Carregando conexões…
      </p>
    );
  if (query.error || !query.data)
    return (
      <div className="grid gap-2">
        <p role="alert" className="text-sm text-destructive">
          {query.error?.message ?? "Não foi possível consultar as conexões."}
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
  const selected = draft ?? query.data.profileId;
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <label
          className="text-sm font-medium"
          htmlFor={`acp-provider-${agentId}`}
        >
          CLI deste agente
        </label>
        <select
          id={`acp-provider-${agentId}`}
          value={selected}
          className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
          disabled={save.isPending || query.isFetching}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        >
          {query.data.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {names[profile.provider]}
              {profile.id !== profile.provider ? ` (${profile.id})` : ""}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted-foreground">
          Seu perfil, memória e ferramentas continuam os mesmos. Ao trocar a
          CLI, este agente passa a usar o modelo padrão da nova conexão nas
          próximas tarefas. Tarefas em andamento continuam na conexão anterior.
        </p>
        <Button
          className="justify-self-start"
          disabled={save.isPending || selected === query.data.profileId}
          onClick={() => save.mutate(selected)}
        >
          {save.isPending ? "Conectando…" : "Salvar CLI"}
        </Button>
        {save.error ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            CLI salva para este agente.
          </p>
        ) : null}
      </section>
      {save.isPending ? null : (
        <AcpModelSelector key={query.data.profileId} agentId={agentId} />
      )}
    </div>
  );
}
