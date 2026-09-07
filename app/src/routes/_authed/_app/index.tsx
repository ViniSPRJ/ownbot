import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import Avatar from "boring-avatars";
import { Input } from "@/components/ui/input";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");
  const { start, pending } = useStartChannel();
  const [search, setSearch] = useState("");
  const visibleAgents = explore?.filter(agent => `${agent.name} ${agent.roleDescription}`.toLocaleLowerCase("pt-BR").includes(search.trim().toLocaleLowerCase("pt-BR")));
  const [error, setError] = useState<string | null>(null);

  /** Default recipient when the composer draft has no mention. */
  const fallback = explore?.[0] ?? agents?.[0];

  return (
    <>
      <SidebarToggleBar />
      <div className="flex-1 min-h-0 min-w-0 w-full overflow-y-auto overflow-x-hidden px-4 pb-10 pt-6 sm:px-8 sm:pt-10">
        <div className="flex flex-col items-center">
          <h2 className="text-sm uppercase text-muted-foreground font-medium tracking-tight text-center">
            ownbot
          </h2>
          <h1 className="text-2xl font-bold tracking-tight mt-1.5 text-center">
            O que vamos fazer hoje?
          </h1>
        </div>
        <div className="mt-8 w-full flex flex-col items-center">
          <Composer
            agents={toAgentOptions(agents)}
            className="w-full max-w-2xl"
            disabled={!fallback}
            onSubmit={async (draft) => {
              // A channel is pinned to one coworker for the life of its thread, so the coworker is
              // chosen now, before it is created. An `@` is an explicit choice and is honoured as-is.
              // With no `@`, the message is routed to the coworker it is for; if that routing cannot
              // run, it falls back to the same default the composer used to always use.
              setError(null);
              try {
                let agentId: string | undefined = draft.agentId ?? undefined;
                if (agentId) {
                  /*
                   * Told to the server so the choice is recorded, and its answer thrown away: the
                   * person already decided and nothing here may change that. Failing to write the
                   * audit row must not stop the conversation, so a rejection is swallowed whole.
                   */
                  await routeMessage(draft.text, agentId).catch(
                    () => undefined,
                  );
                } else {
                  try {
                    agentId = (await routeMessage(draft.text)).agentId;
                  } catch {
                    agentId = fallback?.id;
                  }
                }
                if (!agentId) return;
                await start(agentId, draft.text);
              } catch (caught) {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Não foi possível iniciar a conversa.",
                );
                throw caught;
              }
            }}
            pending={pending}
          />
          {fallback ? (
            // Said out loud: a message that silently reaches somebody you did not choose is the
            // kind of surprise that costs trust the first time it happens.
            <p className="mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center">
              Descreva sua tarefa ou digite <code>@</code> para escolher um agente.
            </p>
          ) : null}
          {error ? (
            <p
              className="mt-2 w-full max-w-2xl text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <section className="mx-auto mt-10 w-full max-w-5xl" aria-labelledby="agents-heading">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="agents-heading" className="font-semibold text-lg">Sua equipe</h2>
              <p className="mt-1 text-sm text-muted-foreground">Escolha um agente para começar uma conversa.</p>
            </div>
            <Input aria-label="Buscar agentes" placeholder="Buscar agente ou especialidade…" value={search} onChange={event => setSearch(event.target.value)} className="w-full sm:w-72" />
          </div>
          <p className="mt-4 text-xs text-muted-foreground" role="status">{visibleAgents?.length ?? 0} agentes disponíveis</p>
          <div className="grid grid-cols-1 gap-3 mt-3 sm:grid-cols-2 lg:grid-cols-3">
            {!!visibleAgents?.length &&
              visibleAgents.map((agent) => (
                <Link
                  key={agent.id}
                  className="group min-w-0 rounded-2xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to="/channel/new"
                  search={{
                    agent: agent.id,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="shrink-0 overflow-hidden rounded-full"><Avatar name={agent.avatarSeed} size={40} /></div>
                    <h3 className="min-w-0 flex-1 break-words font-semibold">{agent.name}</h3>
                    <span aria-hidden="true" className="text-muted-foreground group-hover:text-foreground">↗</span>
                  </div>
                  {agent.runtime && <p className="mt-2 text-xs text-muted-foreground">{agent.runtime.label}</p>}
                  <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{agent.roleDescription}</p>
                  <span className="mt-4 block text-xs font-medium">Conversar →</span>
                </Link>
              ))}
          </div>
          {visibleAgents?.length === 0 && <p className="rounded-xl border border-dashed p-8 mt-3 text-center text-sm text-muted-foreground">Nenhum agente encontrado. Tente outro nome ou especialidade.</p>}
        </section>
      </div>
    </>
  );
}
