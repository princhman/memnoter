import { settled } from "@/lib/async-work";
import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { call as invoke } from "./backend.ts";
import { EXTRACTOR_VERSION, extractFromDoc, extractFromYDoc, type SearchText } from "@/lib/search-text";
import { queryClient } from "@/lib/query-client";
import { assertWritable, MUTATIONS, registerFlusher, type WritePermit } from "@/lib/write-lifecycle";
import { createEditorWriteSync } from "@/lib/editor-write-sync";
import { refreshDerived, loadStoredNote } from "@/lib/note-index";

const editors = createEditorWriteSync(1_000);
export const flushSearchIndexing = editors.flush;
registerFlusher("search", flushSearchIndexing);

async function indexNote(moduleId: string, text: SearchText, backfill = false, permit?: WritePermit) {
  assertWritable(permit);
  await queryClient.getMutationCache().build(queryClient, {
    mutationKey: [MUTATIONS.searchIndex, moduleId],
    gcTime: 0,
    mutationFn: () => invoke("index_note", { moduleId, ...text, version: EXTRACTOR_VERSION, backfill }),
  }).execute(undefined);
  void queryClient.invalidateQueries({ queryKey: ["search-notes"] });
}

export async function indexStoredNote(moduleId: string, doc?: import("yjs").Doc, permit?: WritePermit) {
  const loaded = doc ?? await loadStoredNote(moduleId);
  try { await indexNote(moduleId, extractFromYDoc(loaded), true, permit); }
  finally { if (!doc) loaded.destroy(); }
}

export function useSearchIndexing(editor: Editor | null, moduleId: string, isReady: boolean) {
  useEffect(() => {
    if (!editor || !isReady) return;
    let pending: typeof editor.state.doc | null = editor.state.doc;
    let queue = Promise.resolve();
    const flush = (permit?: WritePermit) => {
      debounce.cancel();
      if (!pending) return queue;
      const snapshot = pending;
      pending = null;
      const write = queue.then(() => indexNote(moduleId, extractFromDoc(snapshot), false, permit)).catch(async error => {
        console.error(`Failed to index open note ${moduleId}; retrying stored text:`, error);
        await refreshDerived(moduleId, permit);
      });
      queue = settled(write);
      return editors.track(write);
    };
    const debounce = editors.attach(flush);
    const changed = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
      if (!transaction.docChanged) return;
      pending = transaction.doc;
      debounce.schedule();
    };
    debounce.schedule();
    editor.on("transaction", changed);
    return () => {
      editor.off("transaction", changed);
      // Always include the last snapshot, even if its timer has already fired.
      void flush().catch(console.error);
      debounce.stop();
    };
  }, [editor, moduleId, isReady]);
}
