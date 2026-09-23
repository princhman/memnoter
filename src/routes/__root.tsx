import { createRootRoute, Outlet } from "@tanstack/react-router";
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

const RootLayout = () => {
  const isFullScrean = useIsFullscreen();
  return (
    <>
      <ActiveEditorProvider>
        <SidebarProvider className="h-dvh overflow-hidden overscroll-none">
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

            <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">
              <Outlet />
            </main>
          </SidebarInset>
          <div className="absolute left-0 top-0.5 z-50 flex h-7 items-center">
            {!isFullScrean && <div className="w-18" />}
            <div className="pl-2">
              <SidebarTrigger />
            </div>
          </div>
        </SidebarProvider>
      </ActiveEditorProvider>

      <TanStackRouterDevtools />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
