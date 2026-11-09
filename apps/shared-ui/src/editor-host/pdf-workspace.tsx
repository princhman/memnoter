import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useActiveEditor } from "@/lib/active-editor-context";
import { postNativeEvent } from "@/lib/backend";
import { documentName } from "@/lib/pdf-state";
import { updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { documentsKey, useDocuments } from "@/lib/use-documents";
import { queryClient } from "@/lib/query-client";
import { PdfQuoteNavigation } from "@/lib/pdf-quote-navigation";
import { PdfQuoteControls } from "@/components/pdf-quote-controls";
import { PdfFileList } from "@/components/pdf-file-list";
import { PdfViewer } from "@/components/pdf-viewer";
import { pdfReaderControls } from "@/lib/pdf-reader-controls";
import { acceptsPdfShortcut, action, matchesShortcut } from "@/lib/shortcuts";
import type { EditorApi, PdfCommand, PdfReaderState } from "./protocol";

export type NativePdfActions = Pick<EditorApi, "toggleFiles" | "refreshDocuments" | "pdfCommand">;

function PdfPanel({ moduleId }: { moduleId: string }) {
  const { data: docs = [] } = useDocuments(moduleId);
  const pane = usePdfPane(moduleId);
  const doc = docs.find(doc => doc.id === pane.active);
  return doc ? <PdfViewer key={doc.id} doc={doc} nativeTools /> : <PdfFileList moduleId={moduleId} docs={docs} hideHeader />;
}

function FullscreenPdf({ documentId }: { documentId: string }) {
  const { data: docs, error } = useDocuments();
  const doc = docs?.find(doc => doc.id === documentId);
  const page = useRouterState({ select: state => state.location.search.page });
  const initialPage = typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : undefined;
  return doc ? <div className="min-h-0 flex-1"><PdfViewer key={`${doc.id}:${initialPage ?? "saved"}`} doc={doc} fullscreen nativeTools initialPage={initialPage} /></div>
    : <p role={error ? "alert" : "status"} className="p-4 text-sm text-muted-foreground">{error?.message ?? (docs ? "Source PDF is no longer available. Your saved quote is still available." : "Loading PDF…")}</p>;
}

/** The note stays mounted, with the native host's original scroll container. */
export function NativePdfWorkspace({ moduleId, actions, children }: { moduleId: string | null; actions: Ref<NativePdfActions>; children: ReactNode }) {
  const pane = usePdfPane(moduleId ?? "");
  const router = useRouter();
  const location = useRouterState({ select: state => state.location });
  const documentId = useRouterState({ select: state => {
    const match = state.matches.find(match => "documentId" in match.params);
    return match && "documentId" in match.params ? match.params.documentId : null;
  } });
  const { activeEditor } = useActiveEditor();
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = !!documentId || !!moduleId && pane.open;
  const coveringNote = open && (!!documentId || !wide);
  const current = useRef({ moduleId, pdf: documentId ?? pane.active });
  current.current = { moduleId, pdf: documentId ?? pane.active };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= 900);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    postNativeEvent("pdfState", { moduleId, open, coveringNote, focused: open && focused });
  }, [moduleId, open, coveringNote, focused]);
  useEffect(() => { if (coveringNote) activeEditor?.editor.view.dom.blur(); }, [coveringNote, activeEditor?.editor]);
  const showNote = () => {
    if (!moduleId) return;
    updatePdfPane(moduleId, { open: false });
    setFocused(false);
    void router.navigate({ to: "/$moduleId", params: { moduleId } });
  };
  const toggleFiles = () => {
    if (!moduleId) return;
    if (documentId) showNote();
    else updatePdfPane(moduleId, { open: !pane.open });
  };
  // The native toolbar draws the reader's controls from this state.
  const { data: allDocs = [] } = useDocuments();
  const controls = useSyncExternalStore(pdfReaderControls.subscribe, pdfReaderControls.get);
  const activeId = documentId ?? (pane.open ? pane.active : null);
  const files = allDocs.filter(doc => doc.moduleId === moduleId);
  const activeDoc = allDocs.find(doc => doc.id === activeId);
  const view = controls && controls.documentId === activeId ? controls.state : null;
  const reader: PdfReaderState | null = open && moduleId ? {
    moduleId, activeId: activeDoc ? activeDoc.id : null, title: activeDoc ? documentName(activeDoc.name) : "Files", fullscreen: !!documentId,
    files: files.map(doc => ({ id: doc.id, name: documentName(doc.name) })),
    page: view?.page ?? 0, pageCount: view?.pageCount ?? 0, zoom: view?.zoom ?? 100,
    selecting: view?.selecting ?? false, annotating: view?.annotating ?? false, canSelect: view?.canSelect ?? false,
    canAnnotate: view?.canAnnotate ?? false, canZoomIn: view?.canZoomIn ?? false, canZoomOut: view?.canZoomOut ?? false,
  } : null;
  const readerJson = JSON.stringify(reader);
  useEffect(() => { postNativeEvent("pdfReader", JSON.parse(readerJson)); }, [readerJson]);
  const pdfCommand = (command: PdfCommand, value?: string | number | null) => {
    const reader = pdfReaderControls.get()?.actions;
    switch (command) {
      case "showFiles": if (documentId) showNote(); if (moduleId) updatePdfPane(moduleId, { open: true, active: null }); break;
      case "openFile": if (moduleId && typeof value === "string") { if (documentId) void router.navigate({ to: "/files/$documentId", params: { documentId: value } }); else updatePdfPane(moduleId, { open: true, active: value }); } break;
      case "zoomIn": reader?.zoomIn(); break;
      case "zoomOut": reader?.zoomOut(); break;
      case "toggleSelect": reader?.toggleSelect(); break;
      case "toggleAnnotate": reader?.toggleAnnotate(); break;
      case "goToPage": if (typeof value === "number") reader?.goToPage(value); break;
      case "openFullscreen": if (activeId) void router.navigate({ to: "/files/$documentId", params: { documentId: activeId } }); break;
      case "openBeside": reader?.openBeside(); break;
      case "backToNote": showNote(); break;
    }
  };
  useImperativeHandle(actions, () => ({ toggleFiles, pdfCommand, async refreshDocuments(id) {
    await queryClient.invalidateQueries({ queryKey: documentsKey });
    if (id === current.current.moduleId) updatePdfPane(id, { open: true, active: null });
  } }));
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!moduleId || !matchesShortcut(event, action("pdf.toggle-pane").keys) || !acceptsPdfShortcut(event, [host.current])) return;
      event.preventDefault(); event.stopPropagation(); toggleFiles();
    };
    window.addEventListener("keydown", toggle, true);
    return () => window.removeEventListener("keydown", toggle, true);
  }, [moduleId, pane.open, documentId]);
  return <div ref={host} data-pdf-note={moduleId ?? undefined} data-covering-note={coveringNote} data-wide={wide} className="native-editor-workspace" onFocusCapture={event => setFocused(!!(event.target instanceof Element && event.target.closest(".native-pdf-pane")))} onPointerDownCapture={event => setFocused(!!(event.target instanceof Element && event.target.closest(".native-pdf-pane")))}>
    {children}
    {moduleId && <><PdfQuoteNavigation moduleId={moduleId} onReveal={() => { if (coveringNote) showNote(); }} /><PdfQuoteControls moduleId={moduleId} onInserted={() => {
      if (coveringNote && router.state.location === location && current.current.moduleId === moduleId && current.current.pdf === (documentId ?? pane.active)) showNote();
    }} /></>}
    {open && <aside aria-label="Files" className={`native-pdf-pane ${coveringNote ? "native-pdf-cover" : "native-pdf-beside"}`}>
      {documentId ? <FullscreenPdf documentId={documentId} /> : moduleId && <PdfPanel moduleId={moduleId} />}
    </aside>}
  </div>;
}
