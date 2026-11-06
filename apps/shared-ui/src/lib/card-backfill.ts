import { Editor } from "@tiptap/core";
import { call as invoke } from "./backend.ts";
import * as Y from "yjs";
import { dueCountsKey, isModuleOpen, startCardSync } from "@/lib/card-sync";
import {
  applySavedContent,
  reconcileContent,
  type GetContentResponse,
} from "@/lib/content";
import { noteExtensions } from "@/lib/note-extensions";
import { queryClient } from "@/lib/query-client";
import { applyPendingSaves, saveQueue } from "@/lib/saves";

const FIRST_RENDER_TIMEOUT_MS = 10_000;

// Loads a note into an editor that is never shown. That gives its card blocks
// ids exactly as opening the note would, and those ids are saved like any edit.
async function indexStoredCards(moduleId: string) {
  // Taken before reading, so an edit saved meanwhile is in one or the other.
  const pending = saveQueue.pending(moduleId);
  const content = await invoke<GetContentResponse>("get_content", { moduleId });
  if (isModuleOpen(moduleId)) return;

  const doc = new Y.Doc();
  applySavedContent(doc, reconcileContent(moduleId, content));
  applyPendingSaves(doc, pending);
  // A note opened meanwhile gives its blocks ids of its own; keep only those.
  const save = (update: Uint8Array, origin: unknown) => {
    if (origin !== "tauri-load" && !isModuleOpen(moduleId)) {
      saveQueue.enqueue(moduleId, Array.from(update));
    }
  };
  doc.on("update", save);

  let editor: Editor | undefined;
  let timeout: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = window.setTimeout(
        () => reject(new Error("Timed out loading the note")),
        FIRST_RENDER_TIMEOUT_MS,
      );
      editor = new Editor({
        element: document.createElement("div"),
        editable: false,
        extensions: noteExtensions({ document: doc, onFirstRender: resolve }),
      });
    });
    if (isModuleOpen(moduleId)) return;

    const sync = startCardSync(editor!, moduleId, () => {
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
    });
    try {
      await sync.flush();
    } finally {
      sync.stop();
    }
  } finally {
    window.clearTimeout(timeout);
    editor?.destroy();
    doc.off("update", save);
    doc.destroy();
  }
}

// Synced changes to a closed note can add or remove its cards.
export function reindexStoredCards(moduleId: string) {
  return indexStoredCards(moduleId);
}

let backfill: Promise<void> | undefined;

// Checks every note never checked for cards, one at a time, once per app
// session. Review waits for it, so its queue includes those notes' cards.
export function backfillCards() {
  backfill ??= (async () => {
    let modules: { id: string }[];
    try {
      modules = await invoke<{ id: string }[]>("unindexed_card_modules");
    } catch (error) {
      console.error("Failed to list notes to check for cards:", error);
      return;
    }
    for (const { id } of modules) {
      // Yield between hidden editors so a migration cannot monopolize the
      // webview while the user is typing or navigating on iPad.
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      // A backup restore swaps the database; its notes are checked next launch.
      if (saveQueue.isSuspended()) return;
      try {
        await indexStoredCards(id);
      } catch (error) {
        // Usually a note deleted since the list was read; the rest still run.
        console.error(`Failed to check note ${id} for cards:`, error);
      }
    }
  })();
  return backfill;
}
