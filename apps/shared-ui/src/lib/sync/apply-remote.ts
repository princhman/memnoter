import { acknowledgeContent, type ContentUpdate, type FileType, type GetContentResponse } from "@/lib/content";
import { dueCountsKey, isModuleOpen } from "@/lib/card-sync";
import { reindexStoredCards } from "@/lib/card-backfill";
import { queryClient } from "@/lib/query-client";
import { indexStoredNote } from "@/lib/search-index";
import { forgetModule } from "@/lib/store";
import { saveQueue } from "@/lib/saves";
import { syncedFileArrived } from "./file-requests";
// Dispatched on window with the module id when another device deleted it.
export const MODULE_DELETED_REMOTELY_EVENT = "memnoter:module-deleted-remotely";

const REINDEX_DELAY_MS = 2_000;

export type ApplyResult = {
  updates: { moduleId: string; update: ContentUpdate }[];
  modulesChanged: boolean;
  deleted: string[];
  reviewsChanged: boolean;
  filesChanged: boolean;
};

const reindexTimers = new Map<string, number>();
const reindexing = new Set<Promise<void>>();
function scheduleReindex(moduleId: string) {
  window.clearTimeout(reindexTimers.get(moduleId));
  reindexTimers.set(
    moduleId,
    window.setTimeout(() => {
      const task = (async () => {
        reindexTimers.delete(moduleId);
        // An open note indexes itself as the editor shows the change.
        if (isModuleOpen(moduleId)) return;
        try {
          await indexStoredNote(moduleId);
          await reindexStoredCards(moduleId);
          void queryClient.invalidateQueries({ queryKey: dueCountsKey });
        } catch (error) {
          console.error(`Failed to index synced note ${moduleId}:`, error);
        }
      })();
      reindexing.add(task);
      void task.finally(() => reindexing.delete(task));
    }, REINDEX_DELAY_MS),
  );
}

export function onRemote(result: ApplyResult) {
  for (const { moduleId, update } of result.updates) {
    // The same path as a local save: an open editor applies the update from
    // the cache, and compaction then includes it.
    acknowledgeContent(moduleId, update);
    queryClient.setQueryData<GetContentResponse>(
      ["content", moduleId],
      (content) => content && { ...content, updates: [...content.updates, update] },
    );
    scheduleReindex(moduleId);
  }
  for (const moduleId of result.deleted) {
    saveQueue.drop(moduleId);
    forgetModule(moduleId);
    window.dispatchEvent(new CustomEvent(MODULE_DELETED_REMOTELY_EVENT, { detail: moduleId }));
    queryClient.removeQueries({ queryKey: ["content", moduleId] });
  }
  if (result.modulesChanged || result.deleted.length > 0) {
    void queryClient.invalidateQueries({ queryKey: ["modules"] });
  }
  if (result.modulesChanged || result.deleted.length > 0 || result.reviewsChanged) {
    // Card schedules are under the due counts' key too.
    void queryClient.invalidateQueries({ queryKey: dueCountsKey });
  }

}

export function onFileStored(moduleId: string, file: FileType) {
  queryClient.setQueryData<GetContentResponse>(
    ["content", moduleId],
    (content) => content && !content.files.some((known) => known.id === file.id)
      ? { ...content, files: [...content.files, file] }
      : content,
  );
  syncedFileArrived();
  // Image occlusion cards need their image to be indexed.
  scheduleReindex(moduleId);
}



// Desktop shutdown drains indexing before replacing its database generation.
export function cancelRemoteReindex() {
  for (const timer of reindexTimers.values()) window.clearTimeout(timer);
  reindexTimers.clear();
}
export async function drainRemoteReindex() {
  cancelRemoteReindex();
  await Promise.allSettled([...reindexing]);
}
