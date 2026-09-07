import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
export type InboxNotification = {
  id: string;
  runId: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
  readAt: string | null;
};
export type InboxPage = {
  notifications: InboxNotification[];
  unreadCount: number;
  nextOffset: number | null;
};
export function inboxQuery(offset = 0) {
  return queryOptions({
    queryKey: ["notifications", offset],
    queryFn: (): Promise<InboxPage> =>
      client(`/api/notifications?offset=${offset}`, "inbox", {
        fallback: "Não foi possível carregar as notificações.",
      }),
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
}
export async function markNotification(id: string, read: boolean) {
  await client(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
    body: { read },
    fallback: "Não foi possível atualizar a notificação.",
  });
}
