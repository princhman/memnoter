import { MentionProvider } from "@/components/mentions";
import { isShowingModule } from "@/lib/open-module";
import { AddPdf } from "@/components/add-pdf";
import { FilesPanelButton, PdfHeaderActions } from "@/components/pdf-header-actions";
import { action, formatKeys } from "@/lib/shortcuts";
import { CardCounts } from "@/components/card-counts";
import { reviewActionsStore } from "@/lib/review-actions";
import { openReview } from "@/components/card-navigation-guard";
import { bootstrapNotes } from "@/lib/bootstrap";
import { createRootRoute, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { startSync } from "@/lib/sync/manager";
import { MODULE_DELETED_REMOTELY_EVENT } from "@/lib/sync/apply-remote";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import AppSidebar from "@/components/app-sidebar";
import CreateModule from "@/components/create-module";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useIsFullscreen } from "@/hooks/use-fullscreen";
import { IS_MAC } from "@/lib/platform";
import { FileBreadcrumb } from "@/components/file-breadcrumb";
import { ModuleReviewButton } from "@/components/module-review-button";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { UndoRedo } from "@/components/undo-redo";
import { FindBar } from "@/components/find-bar";
import { CommandPalette } from "@/components/command-palette";
import { IconTooltip } from "@/components/icon-tooltip";
import { useSelector } from "@tanstack/react-store";
import { appStore, setSidebarOpen } from "@/lib/store";
import SaveStatus from "@/components/save-status";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCommand } from "@/lib/commands";
import { OPEN_SETTINGS_EVENT, requestApp, usesNativeMenuShortcuts } from "@/lib/app-events";

const RootLayout = () => {
  const isFullscreen = useIsFullscreen();
  const path = useRouterState({ select: state => state.location.pathname });
  const isPdfReader = /^\/files\/[^/]+/.test(path);
  const ownScroll = isPdfReader || !["/", "/files", "/files/", "/review", "/settings"].includes(path);
  const sidebarOpen = useSelector(appStore, (state) => state.sidebarOpen);
  const navigate = useNavigate();
  const router = useRouter();
  const reviewCounts = useSelector(reviewActionsStore, (state) => state?.counts);
  const reviewCurrent = useSelector(reviewActionsStore, (state) => state?.current);

  useCommand({ id: "review.all", title: "Review all cards", keywords: ["flashcards"],
    run: () => openReview(() => navigate({ to: "/review", search: {} })),
  });
  useCommand({
    ...action("settings.open"),
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
    void bootstrapNotes();
  }, []);

  useEffect(() => {
    void startSync();
  }, []);

  // Another device deleted the note shown here.
  useEffect(() => {
    const leave = (event: Event) => {
      const moduleId = (event as CustomEvent<string>).detail;
      const showing = isShowingModule(router.state.matches, moduleId);
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
      <ActiveEditorProvider><MentionProvider>
        <SidebarProvider usesNativeMenuShortcuts={usesNativeMenuShortcuts}
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          // Fills the body, which keeps clear of the iPad's status bar.
          className="relative h-full min-h-0 overflow-hidden overscroll-none"
          // Avoid resizing and recentering PDF canvases on every animation frame.
          style={{
            ...(toolbarWidth === null ? {} : { "--toolbar-width": `${toolbarWidth}px` }),
            ...(isPdfReader ? { "--sidebar-motion-duration": "0ms" } : {}),
          } as CSSProperties}
        >
          <AppSidebar />
          <CreateModule />
          <AddPdf />

          <SidebarInset className="min-h-0 overflow-hidden">
            {/* Tauri's deep region includes noninteractive breadcrumb wrappers,
                while links, buttons, inputs and menu items block dragging. */}
            <header data-tauri-drag-region="deep" className="relative z-40 flex h-8 shrink-0 items-center bg-background">
              <div className="flex min-w-0 items-center">
                <FileBreadcrumb />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 pr-3">
                <PdfHeaderActions />
                {reviewCounts ? <CardCounts className="text-sm" counts={reviewCounts} current={reviewCurrent} /> : <ModuleReviewButton />}
                <FilesPanelButton />
              </div>
            </header>

            <FindBar />

            <main className={ownScroll ? "min-h-0 flex-1 overflow-hidden" : "app-scroll-container min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8"}>
              <Outlet />
            </main>
          </SidebarInset>
          <div ref={toolbar} data-tauri-drag-region="deep" className="absolute left-0 top-0 z-50 flex h-8 items-center">
            {IS_MAC && !isFullscreen && <div className="h-full w-18" />}
            <div className="flex items-center pl-2 gap-1.5">
              <IconTooltip label="Toggle sidebar" hint={formatKeys(action("sidebar.toggle").keys)} side="bottom">
                <SidebarTrigger aria-label="Toggle sidebar" />
              </IconTooltip>
              <UndoRedo />
            </div>
          </div>
          <CommandPalette />
        </SidebarProvider>
      </MentionProvider></ActiveEditorProvider>

      <SaveStatus />

      <TanStackRouterDevtools />
    </>
  );
};

export const Route = createRootRoute({ component: RootLayout });
