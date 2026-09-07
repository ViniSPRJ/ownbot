import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { NotificationInbox } from "@/components/notifications/inbox";
export const Route = createFileRoute("/_authed/_app/notifications")({
  component: NotificationsPage,
});
function NotificationsPage() {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain" data-notifications-scroll>
    <PageShell
      title="Notificações"
      description="Conclusões, falhas e resumos das suas rotinas. Atualiza automaticamente enquanto o OpenBot está aberto."
    >
      <NotificationInbox />
    </PageShell>
    </div>
  );
}
