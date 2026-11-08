import { LOAD_ORIGIN } from "./content";
import { Editor } from "@tiptap/core";
import { dueCountsKey, isModuleOpen, startCardSync } from "@/lib/card-sync";
import { noteExtensions } from "@/lib/editor-schema";
import { queryClient } from "@/lib/query-client";
import { saveQueue } from "@/lib/saves";

import type { WritePermit } from "@/lib/write-lifecycle";

const FIRST_RENDER_TIMEOUT_MS = 10_000;

// Loads a note into an editor that is never shown. That gives its card blocks
// ids exactly as opening the note would, and those ids are saved like any edit.
export async function indexStoredCards(moduleId: string, doc: import("yjs").Doc, permit?: WritePermit) {
  if (isModuleOpen(moduleId)) return;
  // A note opened meanwhile gives its blocks ids of its own; keep only those.
  const save = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOAD_ORIGIN && !isModuleOpen(moduleId)) {
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
    }, permit);
    try {
      await sync.flush(permit);
    } finally {
      sync.stop();
    }
  } finally {
    window.clearTimeout(timeout);
    editor?.destroy();
    doc.off("update", save);
  }
}

// Review shares the startup service's single backfill run.
export { startBackfill as backfillCards } from "@/lib/note-index";
