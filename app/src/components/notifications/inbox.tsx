import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PushNotificationControls } from "@/components/notifications/push-controls";
import { inboxQuery, markNotification } from "@/lib/notifications/queries";

export function NotificationInbox() {
  const [offset, setOffset] = useState(0);
  const inbox = useQuery(inboxQuery(offset));
  const queryClient = useQueryClient();
  const mark = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      markNotification(id, read),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  return (
    <div className="space-y-4 min-w-0">
      <p className="text-sm text-muted-foreground">
        {inbox.data ? `${inbox.data.unreadCount} não lidas. ` : ""}Resumos e
        resultados ficam aqui, disponíveis após entrar na sua conta.
      </p>
      <PushNotificationControls />
      {inbox.isPending && <p role="status">Carregando notificações…</p>}
      {inbox.isError && (
        <p role="alert">
          Não foi possível atualizar as notificações.{" "}
          <Button variant="outline" onClick={() => inbox.refetch()}>
            Tentar novamente
          </Button>
        </p>
      )}
      {mark.isError && (
        <p role="alert">
          Não foi possível marcar a notificação. Tente novamente.
        </p>
      )}
      {inbox.data?.notifications.length === 0 && (
        <p className="rounded-xl border p-6 text-muted-foreground">
          Nenhuma notificação nesta página. Os próximos resultados das rotinas
          aparecerão aqui.
        </p>
      )}
      {inbox.data?.notifications.map((n) => (
        <article
          key={n.id}
          className={`rounded-xl border p-4 space-y-3 min-w-0 ${n.readAt ? "" : "border-primary/50 bg-primary/5"}`}
        >
          <div className="flex flex-wrap justify-between items-center gap-2">
            <h2 className="font-medium">
              {!n.readAt && (
                <span
                  aria-label="Não lida"
                  className="inline-block rounded-full bg-primary size-2 mr-2"
                />
              )}
              {n.title}
            </h2>
            <time
              className="text-xs text-muted-foreground"
              dateTime={n.createdAt}
            >
              {new Date(n.createdAt).toLocaleString("pt-BR")}
            </time>
          </div>
          <p className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {n.summary}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <Link
              className="text-sm underline underline-offset-4 py-2"
              to="/routine-runs/$runId"
              params={{ runId: n.runId }}
              onClick={() => {
                if (!n.readAt) mark.mutate({ id: n.id, read: true });
              }}
            >
              Ver execução completa
            </Link>
            <Button
              variant="ghost"
              disabled={mark.isPending}
              onClick={() => mark.mutate({ id: n.id, read: !n.readAt })}
            >
              {n.readAt ? "Marcar como não lida" : "Marcar como lida"}
            </Button>
          </div>
        </article>
      ))}
      <div className="flex gap-2">
        {offset > 0 && (
          <Button
            variant="outline"
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Mais recentes
          </Button>
        )}
        {inbox.data?.nextOffset != null && (
          <Button
            variant="outline"
            onClick={() => setOffset(inbox.data!.nextOffset!)}
          >
            Mais antigas
          </Button>
        )}
      </div>
    </div>
  );
}
