import { CardCounts } from "@/components/card-counts";
import { reviewActionsStore } from "@/lib/review-actions";
import { openReview } from "@/lib/card-sync";
import { backfillCards } from "@/lib/card-backfill";
import { createRootRoute, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { MODULE_DELETED_REMOTELY_EVENT, startSync } from "@/lib/sync/manager";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import AppSidebar from "@/components/app-sidebar";
import CreateModule from "@/components/create-module";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useIsFullscreen } from "@/hooks/use-fullscreen";
import { FileBreadcrumb } from "@/components/file-breadcrumb";
import { ModuleReviewButton } from "@/components/module-review-button";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { UndoRedo } from "@/components/undo-redo";
import { FindBar } from "@/components/find-bar";
import { CommandPalette } from "@/components/command-palette";
import { IconTooltip } from "@/components/icon-tooltip";
import { MOD_KEY } from "@/lib/utils";
import { useSelector } from "@tanstack/react-store";
import { appStore, setSidebarOpen } from "@/lib/store";
import SaveStatus from "@/components/save-status";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCommand } from "@/lib/commands";
import { OPEN_SETTINGS_EVENT, requestApp } from "@/lib/app-events";

const RootLayout = () => {
  const isFullScrean = useIsFullscreen();
  const sidebarOpen = useSelector(appStore, (state) => state.sidebarOpen);
  const navigate = useNavigate();
  const router = useRouter();
  const reviewCounts = useSelector(reviewActionsStore, (state) => state?.counts);
  const reviewCurrent = useSelector(reviewActionsStore, (state) => state?.current);

  useCommand({ id: "review.all", title: "Review all cards", keywords: ["flashcards"],
    run: () => openReview(() => navigate({ to: "/review", search: {} })),
  });
  useCommand({
    id: "settings.open",
    title: "Settings",
    shortcut: `${MOD_KEY},`,
    run: () => requestApp(OPEN_SETTINGS_EVENT),
  });

  // Dispatched by the app menu.
  useEffect(() => {
    const openSettings = () => void navigate({ to: "/settings" });
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () =>
      window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, [navigate]);

  // Due counts and review include notes not opened since cards existed.
  useEffect(() => {
    void backfillCards();
  }, []);

  useEffect(() => {
    void startSync();
  }, []);

  // Another device deleted the note shown here.
  useEffect(() => {
    const leave = (event: Event) => {
      const moduleId = (event as CustomEvent<string>).detail;
      const showing = router.state.matches.some(
        (match) => "moduleId" in match.params && match.params.moduleId === moduleId,
      );
      if (showing) void router.navigate({ to: "/", replace: true });
    };
    window.addEventListener(MODULE_DELETED_REMOTELY_EVENT, leave);
    return () => window.removeEventListener(MODULE_DELETED_REMOTELY_EVENT, leave);
  }, [router]);

  // The breadcrumbs start after the toolbar while the sidebar is closed, and
  // the toolbar's buttons depend on the page.
  const toolbar = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setToolbarWidth(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <ActiveEditorProvider>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          // Fills the body, which keeps clear of the iPad's status bar.
          className="relative h-full min-h-0 overflow-hidden overscroll-none"
          style={
            toolbarWidth === null
              ? undefined
              : ({ "--toolbar-width": `${toolbarWidth}px` } as CSSProperties)
          }
        >
          <AppSidebar />
          <CreateModule global />

          <SidebarInset className="min-h-0 overflow-hidden">
            {/* Tauri's deep region includes noninteractive breadcrumb wrappers,
                while links, buttons, inputs and menu items block dragging. */}
            <header data-tauri-drag-region="deep" className="relative z-40 flex h-8 shrink-0 items-center bg-background">
              <div className="flex min-w-0 items-center">
                <FileBreadcrumb />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 pr-3">
                {reviewCounts ? <CardCounts className="text-sm" counts={reviewCounts} current={reviewCurrent} /> : <ModuleReviewButton />}
              </div>
            </header>

            <FindBar />

            <main className="app-scroll-container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">
              <Outlet />
            </main>
          </SidebarInset>
          <div ref={toolbar} data-tauri-drag-region="deep" className="absolute left-0 top-0 z-50 flex h-8 items-center">
            {!isFullScrean && <div className="h-full w-18" />}
            <div className="flex items-center pl-2 gap-1.5">
              <IconTooltip label="Toggle sidebar" hint={`${MOD_KEY}D`} side="bottom">
                <SidebarTrigger aria-label="Toggle sidebar" />
              </IconTooltip>
              <UndoRedo />
            </div>
          </div>
          <CommandPalette />
        </SidebarProvider>
      </ActiveEditorProvider>

      <SaveStatus />

      <TanStackRouterDevtools />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
