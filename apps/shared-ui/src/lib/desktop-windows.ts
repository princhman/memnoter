import { toast } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, isTauri, listen } from "./backend";
import { contentKey, type ContentUpdate, type FileType } from "./content";
import { cardsChanged } from "./card-events";
import { dueCountsKey } from "./card-sync";
import { modulesCache } from "./modules";
import { refreshPdfAnnotations } from "./pdf-annotation-store";
import { queryClient } from "./query-client";
import { bankKey } from "./question-bank";
import { applyRemoteChanges, onFileStored, type ApplyResult } from "./sync/apply-remote";
import { requestSyncedFile, setSyncedFileHandler } from "./sync/file-requests";
import { documentsKey } from "./use-documents";

declare global {
  interface Window {
    __memnoterInitialModule?: string | null;
  }
}

export function openDesktopWindow(moduleId?: string) {
  return call("open_window", { moduleId }).catch(error => {
    toast.error("Could not open a new window", { description: error.message });
  });
}

export async function startWindowEvents() {
  if (!isTauri()) return;
  const primary = getCurrentWindow().label === "main";
  if (!primary) {
    setSyncedFileHandler(fileId => {
      void call("request_desktop_file", { fileId }).catch(console.error);
    });
  }
  await Promise.all([
    // The same cache updates as a synced edit; the saving window indexes it.
    listen<{ moduleId: string; update: ContentUpdate }>("note-update-saved", ({ payload }) => applyRemoteChanges({
      updates: [payload], deleted: [], modulesChanged: false, reviewsChanged: false, filesChanged: false,
    }, false)),
    listen<{ moduleId: string; file: FileType }>("note-file-saved", ({ payload: { moduleId, file } }) => {
      onFileStored(moduleId, file, false);
      // A read which began before the file write may still be in flight.
      void queryClient.invalidateQueries({ queryKey: contentKey(moduleId), exact: true });
    }),
    listen<ApplyResult>("desktop-sync-applied", ({ payload }) => applyRemoteChanges(payload, false)),
    listen<string>("desktop-module-deleted", ({ payload }) => applyRemoteChanges({
      updates: [], deleted: [payload], modulesChanged: true, reviewsChanged: true, filesChanged: false,
    }, false)),
    listen<string>("desktop-file-requested", ({ payload }) => {
      if (primary) requestSyncedFile(payload);
    }),
    listen("desktop-library-changed", () => {
      void modulesCache.invalidate();
      void queryClient.invalidateQueries({ queryKey: ["sidebar-items"] });
    }),
    listen("desktop-search-changed", () => void queryClient.invalidateQueries({ queryKey: ["search-notes"] })),
    listen("desktop-cards-changed", () => {
      cardsChanged();
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
    }),
    listen("desktop-documents-changed", () => void queryClient.invalidateQueries({ queryKey: documentsKey })),
    listen<string>("desktop-annotations-changed", ({ payload }) => refreshPdfAnnotations([payload])),
    listen<string>("desktop-worksheet-changed", ({ payload }) => {
      void queryClient.invalidateQueries({ queryKey: contentKey(payload) });
      void queryClient.invalidateQueries({ queryKey: bankKey(payload) });
    }),
  ]);
  if (primary) await call("primary_window_ready");
}
