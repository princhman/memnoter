import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import { applySavedContent, type GetContentResponse } from "@/lib/content";
import {
  EXTRACTOR_VERSION,
  extractFromDoc,
  extractFromYDoc,
  type SearchText,
} from "@/lib/search-text";

const INDEX_DEBOUNCE_MS = 1_000;

async function indexNote(moduleId: string, text: SearchText, backfill = false) {
  try {
    await invoke("index_note", { moduleId, ...text, version: EXTRACTOR_VERSION, backfill });
  } catch (error) {
    console.error("Failed to index note for search:", error);
  }
}

// Keeps the open note's search text current: once after it loads, then about a
// second after edits stop, and immediately when the note closes or the app
// quits. Nothing is indexed before loading, so a failed load cannot erase it.
export function useSearchIndexing(
  editor: Editor | null,
  moduleId: string,
  isReady: boolean,
) {
  useEffect(() => {
    if (!editor || !isReady) return;

    // Documents are immutable, so keeping the latest one is enough.
    let pending: Node | null = editor.state.doc;
    let timeout: number | undefined;

    const flush = () => {
      window.clearTimeout(timeout);
      timeout = undefined;
      if (!pending) return;
      const text = extractFromDoc(pending);
      pending = null;
      void indexNote(moduleId, text);
    };
    const schedule = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(flush, INDEX_DEBOUNCE_MS);
    };
    const handleTransaction = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      if (!transaction.docChanged) return;
      pending = transaction.doc;
      schedule();
    };

    schedule();
    editor.on("transaction", handleTransaction);
    window.addEventListener("pagehide", flush);
    return () => {
      editor.off("transaction", handleTransaction);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [editor, moduleId, isReady]);
}

function whenIdle() {
  return new Promise<void>((resolve) => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
    } else {
      setTimeout(resolve, 50);
    }
  });
}

// Builds a note's search text from its saved Yjs state, without an editor.
export async function indexStoredNote(moduleId: string) {
  const content = await invoke<GetContentResponse>("get_content", { moduleId });
  const doc = new Y.Doc();
  try {
    applySavedContent(doc, content);
    await indexNote(moduleId, extractFromYDoc(doc), true);
  } finally {
    doc.destroy();
  }
}

let backfillStarted = false;

// Indexes, one at a time in idle time, every note that was never indexed or
// was indexed by an older extractor. Runs once per app session.
export async function backfillSearchIndex() {
  if (backfillStarted) return;
  backfillStarted = true;

  let moduleIds: string[];
  try {
    moduleIds = await invoke<string[]>("unindexed_modules", {
      version: EXTRACTOR_VERSION,
    });
  } catch (error) {
    console.error("Failed to list notes to index:", error);
    return;
  }
  for (const moduleId of moduleIds) {
    await whenIdle();
    try {
      await indexStoredNote(moduleId);
    } catch (error) {
      // Usually a note deleted since the list was read; the rest still run.
      console.error(`Failed to index note ${moduleId}:`, error);
    }
  }
}
