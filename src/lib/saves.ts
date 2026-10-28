import { invoke } from "@tauri-apps/api/core";
import { createStore } from "@tanstack/react-store";
import * as Y from "yjs";
import { queryClient } from "@/lib/query-client";
import { createSaveQueue, type SaveQueueStatus } from "@/lib/save-queue";
import type { ContentUpdate, GetContentResponse } from "@/lib/content";

export const saveStatusStore = createStore<SaveQueueStatus>({
  pending: 0,
  failing: false,
  lastError: null,
});

// Module-level so switching notes keeps retrying the previous note's edits.
export const saveQueue = createSaveQueue<number[], ContentUpdate>({
  persist: (moduleId, bytes) =>
    invoke<ContentUpdate>("add_update", { moduleId, bytes }),
  onSaved: (moduleId, update) => {
    queryClient.setQueryData<GetContentResponse>(
      ["content", moduleId],
      (oldContent) =>
        oldContent && {
          ...oldContent,
          updates: [...oldContent.updates, update],
        },
    );
  },
  onStatus: (status) => saveStatusStore.setState(() => status),
  onError: (_, error) => console.error("Failed to save Tiptap update:", error),
});

// Edits still waiting to be saved are in neither the database nor the cache.
// A reopened note applies them, so it shows them and compaction keeps them.
export function applyPendingSaves(doc: Y.Doc, updates: readonly number[][]) {
  if (updates.length === 0) return;
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  }, "tauri-load");
}

export function flushSaves(timeoutMs: number) {
  return Promise.race([
    saveQueue.flush(),
    new Promise<boolean>((resolve) =>
      window.setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}
