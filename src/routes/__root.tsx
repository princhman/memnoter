import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useIsFullscreen } from "@/hooks/use-fullscreen";

const RootLayout = () => {
  const isFullScrean = useIsFullscreen();
  return (
    <>
      <SidebarProvider className="h-dvh overflow-hidden overscroll-none">
        <AppSidebar />

        <SidebarInset className="min-h-0 overflow-hidden">
          <div
            data-tauri-drag-region
            className="absolute inset-x-0 top-0 z-50 h-12"
          />
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

      <TanStackRouterDevtools />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
