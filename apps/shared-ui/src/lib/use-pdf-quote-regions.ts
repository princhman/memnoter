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

export interface PdfQuoteRegion extends PdfRegion {
  uses: readonly { quoteId: string; label: string }[];
}
export type PdfQuoteRegionsByPage = ReadonlyMap<number, readonly PdfQuoteRegion[]>;
type QuoteSource = { source: PdfSource; quoteId: unknown; label: string };

function savedText(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toDelta().map((part: { insert?: unknown }) => typeof part.insert === "string" ? part.insert : "").join("");
  return node.toArray().map(child => child instanceof Y.XmlElement || child instanceof Y.XmlText ? savedText(child) : "").join("");
}

function regionKey(region: PdfRegion) {
  return `${region.x},${region.y},${region.width},${region.height}`;
}

// A disposable reader only: never starts an editor, cleanup, or persistence.
function savedSources(moduleId: string, content: GetContentResponse | undefined) {
  if (!content) return [];
  const doc = new Y.Doc();
  const sources: QuoteSource[] = [];
  let section = "Note", occurrence = 0;
  try {
    applySavedContent(doc, reconcileContent(moduleId, content));
    applyPendingSaves(doc, saveQueue.pending(moduleId));
    if (doc.store.pendingStructs || doc.store.pendingDs) return [];
    for (const node of doc.getXmlFragment("default").createTreeWalker(() => true)) {
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName === "heading") { section = savedText(node).trim() || "Untitled section"; occurrence = 0; }
      if (node.nodeName !== "image" && node.nodeName !== "inlineImage" && node.nodeName !== "pdfTextQuote") continue;
      const source = parsePdfSource(node.getAttribute("pdfSource"));
      if (source) sources.push({ source, quoteId: node.getAttribute(node.nodeName === "pdfTextQuote" ? "quoteId" : "imageId"), label: `${section}, quote ${++occurrence}` });
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
    const result: QuoteSource[] = [];
    let section = "Note", occurrence = 0;
    editorDoc.descendants(node => {
      if (node.type.name === "heading") { section = node.textContent.trim() || "Untitled section"; occurrence = 0; }
      if (node.type.name !== "image" && node.type.name !== "inlineImage" && node.type.name !== "pdfTextQuote") return;
      const source = parsePdfSource(node.attrs.pdfSource);
      if (source) result.push({ source, quoteId: node.type.name === "pdfTextQuote" ? node.attrs.quoteId : node.attrs.imageId, label: `${section}, quote ${++occurrence}` });
    });
    return result;
  }, [editorDoc, moduleId, data, saveStatus]);
  const previous = useRef<PdfQuoteRegionsByPage>(new Map());
  return useMemo(() => {
    const pages = new Map<number, Map<string, PdfQuoteRegion>>();
    const drafts: QuoteSource[] = [];
    if (pending?.moduleId === moduleId) {
      const candidates = pending.kind === "image" ? [pending.source] : pending.parts.map(part => part.source);
      for (const candidate of candidates) {
        const source = parsePdfSource(candidate);
        if (source) drafts.push({ source, quoteId: null, label: "" });
      }
    }
    for (const { source, quoteId, label } of [...sources, ...drafts]) {
      if (source.documentId !== documentId) continue;
      let page = pages.get(source.page);
      if (!page) pages.set(source.page, page = new Map());
      const key = regionKey(source.region);
      const region = page.get(key) ?? { ...source.region, uses: [] };
      if (typeof quoteId === "string" && quoteId.trim() && !region.uses.some(use => use.quoteId === quoteId)) {
        region.uses = [...region.uses, { quoteId, label }];
      }
      page.set(key, region);
    }
    const grouped = new Map<number, readonly PdfQuoteRegion[]>();
    for (const [page, regions] of pages) {
      const sorted = [...regions.entries()].sort(([a], [b]) => a.localeCompare(b));
      const old = previous.current.get(page);
      grouped.set(page, old?.length === sorted.length && sorted.every(([key, region], index) => regionKey(old[index]) === key && JSON.stringify(old[index].uses) === JSON.stringify(region.uses))
        ? old : sorted.map(([, region]) => region));
    }
    if (grouped.size === previous.current.size && [...grouped].every(([page, regions]) => previous.current.get(page) === regions)) {
      return previous.current;
    }
    previous.current = grouped;
    return grouped;
  }, [sources, pending, moduleId, documentId]);
}
