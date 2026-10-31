import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import AppSidebar from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useIsFullscreen } from "@/hooks/use-fullscreen";
import { FileBreadcrumb } from "@/components/file-breadcrumb";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { UndoRedo } from "@/components/undo-redo";
import { FindBar } from "@/components/find-bar";
import { useSelector } from "@tanstack/react-store";
import { appStore, setSidebarOpen } from "@/lib/store";
import SaveStatus from "@/components/save-status";
import { useEffect } from "react";

const RootLayout = () => {
  const isFullScrean = useIsFullscreen();
  const sidebarOpen = useSelector(appStore, (state) => state.sidebarOpen);
  const navigate = useNavigate();

  // Dispatched by the app menu.
  useEffect(() => {
    const openSettings = () => void navigate({ to: "/settings" });
    window.addEventListener("memnoter:open-settings", openSettings);
    return () =>
      window.removeEventListener("memnoter:open-settings", openSettings);
  }, [navigate]);

  return (
    <>
      <ActiveEditorProvider>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="h-dvh overflow-hidden overscroll-none"
        >
          <AppSidebar />

          <SidebarInset className="min-h-0 overflow-hidden">
            <div
              data-tauri-drag-region
              className="absolute inset-x-0 top-0 z-50 h-4"
            />

            <header className="relative z-40 flex h-8 items-center bg-background">
              <div className="flex items-center">
                <FileBreadcrumb />
              </div>
            </header>

            <FindBar />

            <main className="app-scroll-container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">
              <Outlet />
            </main>
          </SidebarInset>
          <div className="absolute left-0 top-0.5 z-50 flex h-7 items-center">
            {!isFullScrean && <div className="w-18" />}
            <div className="flex items-center pl-2 gap-1.5">
              <SidebarTrigger />
              <UndoRedo />
            </div>
          </div>
        </SidebarProvider>
      </ActiveEditorProvider>

      <SaveStatus />

      <TanStackRouterDevtools />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
