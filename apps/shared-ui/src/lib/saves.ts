import { call as invoke } from "./backend.ts";
import { createStore } from "@tanstack/react-store";
import * as Y from "yjs";
import { createSaveQueue, type SaveQueueStatus } from "@/lib/save-queue";
import { appendSavedUpdate, appliedContentUpdateId, LOAD_ORIGIN, type ContentUpdate } from "@/lib/content";
import type { CardTransfer } from "./cloze-clipboard";

const movesByUpdate = new WeakMap<number[], CardTransfer[]>();
const latestEdit = new WeakMap<Y.Doc, number[]>();
const receipts = new WeakMap<number[], number>();

export function enqueueNoteUpdate(doc: Y.Doc, moduleId: string, bytes: number[], moves: CardTransfer[] = []) {
  latestEdit.set(doc, bytes);
  if (moves.length) movesByUpdate.set(bytes, [...moves]);
  saveQueue.enqueue(moduleId, bytes);
}

export function noteSaveCheckpoint(doc: Y.Doc, moduleId: string) {
  const appliedId = appliedContentUpdateId.get(doc);
  const edit = latestEdit.get(doc);
  return {
    appliedId,
    edit,
    async whenSaved() {
      return edit !== undefined && await saveQueue.flushThrough(moduleId, edit, true) && receipts.has(edit);
    },
    async updateId() {
      if (!edit) return appliedId;
      if (!await saveQueue.flushThrough(moduleId, edit)) throw new Error("Could not save note before indexing cards.");
      const savedId = receipts.get(edit);
      return savedId === undefined ? appliedId : Math.max(appliedId ?? 0, savedId);
    },
  };
}

export const saveStatusStore = createStore<SaveQueueStatus>({
  pending: 0,
  failing: false,
  lastError: null,
});

// Module-level so switching notes keeps retrying the previous note's edits.
export const saveQueue = createSaveQueue<number[], ContentUpdate>({
  persist: async (moduleId, bytes) => {
    // The save queue retries the same operation IDs after an interrupted
    // write. The destination must never reach disk before its history.
    for (const move of movesByUpdate.get(bytes) ?? []) {
      const result = await invoke<unknown>("transfer_card", { ...move, toModule: moduleId });
      if (result !== "moved" && result !== "source_missing") {
        throw new Error("Could not move the card history to the pasted card.");
      }
    }
    const receipt = await invoke<ContentUpdate>("add_update", { moduleId, bytes });
    receipts.set(bytes, receipt.id);
    return receipt;
  },
  onSaved: appendSavedUpdate,
  onStatus: (status) => saveStatusStore.setState(() => status),
  onError: (_, error) => console.error("Failed to save Tiptap update:", error),
});

// Edits still waiting to be saved are in neither the database nor the cache.
// A reopened note applies them, so it shows them and compaction keeps them.
export function applyPendingSaves(doc: Y.Doc, updates: readonly number[][]) {
  const latest = updates[updates.length - 1];
  if (!latest) return;
  latestEdit.set(doc, latest);
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  }, LOAD_ORIGIN);
}

export function flushSaves() {
  return saveQueue.flush();
}
