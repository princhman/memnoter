import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import * as Y from "yjs";
import { useActiveEditor } from "./active-editor-context";
import { call } from "./backend";
import { applySavedContent, contentQueryOptions, reconcileContent, type GetContentResponse } from "./content";
import { pendingPdfQuote } from "./pending-pdf-quote";
import { parsePdfSource, type PdfRegion, type PdfSource } from "./pdf-quote";
import { applyPendingSaves, saveQueue, saveStatusStore } from "./saves";

export type PdfQuoteRegionsByPage = ReadonlyMap<number, readonly PdfRegion[]>;

function regionKey(region: PdfRegion) {
  return `${region.x},${region.y},${region.width},${region.height}`;
}

// A disposable reader only: never starts an editor, cleanup, or persistence.
function savedSources(moduleId: string, content: GetContentResponse | undefined) {
  if (!content) return [];
  const doc = new Y.Doc();
  const sources: PdfSource[] = [];
  try {
    applySavedContent(doc, reconcileContent(moduleId, content));
    applyPendingSaves(doc, saveQueue.pending(moduleId));
    if (doc.store.pendingStructs || doc.store.pendingDs) return [];
    for (const node of doc.getXmlFragment("default").createTreeWalker(() => true)) {
      if (!(node instanceof Y.XmlElement) || (node.nodeName !== "image" && node.nodeName !== "inlineImage")) continue;
      const source = parsePdfSource(node.getAttribute("pdfSource"));
      if (source) sources.push(source);
    }
    return sources;
  } catch {
    // A missing or damaged note must not prevent reading the PDF.
    return [];
  } finally {
    doc.destroy();
  }
}

/** Pages are one-based. Unchanged page arrays retain identity for memoized PDF pages. */
export function usePdfQuoteRegions(moduleId: string, documentId: string): PdfQuoteRegionsByPage {
  const { activeEditor } = useActiveEditor();
  const editor = activeEditor?.moduleId === moduleId && activeEditor.isReady && !activeEditor.editor.isDestroyed
    ? activeEditor.editor : null;
  const subscribe = useCallback((notify: () => void) => {
    if (!editor) return () => {};
    editor.on("transaction", notify);
    return () => { editor.off("transaction", notify); };
  }, [editor]);
  const snapshot = useCallback(() => editor?.state.doc ?? null, [editor]);
  const editorDoc = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { data } = useQuery({
    ...contentQueryOptions(moduleId),
    queryFn: () => call<GetContentResponse>("get_content", { moduleId }),
    enabled: !editor,
    staleTime: Infinity,
  });
  const saveStatus = useSelector(saveStatusStore, state => state);
  const pending = useSelector(pendingPdfQuote, state => state);
  const sources = useMemo(() => {
    if (!editorDoc) return savedSources(moduleId, data);
    const result: PdfSource[] = [];
    editorDoc.descendants(node => {
      if (node.type.name !== "image" && node.type.name !== "inlineImage") return;
      const source = parsePdfSource(node.attrs.pdfSource);
      if (source) result.push(source);
    });
    return result;
  }, [editorDoc, moduleId, data, saveStatus]);
  const previous = useRef<PdfQuoteRegionsByPage>(new Map());
  return useMemo(() => {
    const pages = new Map<number, Map<string, PdfRegion>>();
    const draft = pending?.moduleId === moduleId ? parsePdfSource(pending.source) : null;
    for (const source of draft ? [...sources, draft] : sources) {
      if (source.documentId !== documentId) continue;
      let page = pages.get(source.page);
      if (!page) pages.set(source.page, page = new Map());
      page.set(regionKey(source.region), source.region);
    }
    const grouped = new Map<number, readonly PdfRegion[]>();
    for (const [page, regions] of pages) {
      const sorted = [...regions.entries()].sort(([a], [b]) => a.localeCompare(b));
      const old = previous.current.get(page);
      grouped.set(page, old?.length === sorted.length && sorted.every(([key], index) => regionKey(old[index]) === key)
        ? old : sorted.map(([, region]) => region));
    }
    if (grouped.size === previous.current.size && [...grouped].every(([page, regions]) => previous.current.get(page) === regions)) {
      return previous.current;
    }
    previous.current = grouped;
    return grouped;
  }, [sources, pending, moduleId, documentId]);
}
