import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { WorkspaceModeProvider } from "@/components/workspace-mode-provider";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // Which half of the roster is open is shared by the switch in the sidebar and by the route that
    // starts a conversation, so it is held here, above both of them.
    <WorkspaceModeProvider>
      {/*
       * One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
       * scroller size against the page, grow it, and grow again.
       */}
      <SidebarShell className="h-dvh max-h-dvh overflow-hidden" width="340px">
        <AppSidebar />
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <Outlet />
        </main>
      </SidebarShell>
    </WorkspaceModeProvider>
  );
}
