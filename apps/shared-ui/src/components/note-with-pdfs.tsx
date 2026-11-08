import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, FileText, Maximize2, Plus, X } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { documentName } from "@/lib/pdf-state";
import { openPdfPane, updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { acceptsPdfShortcut, action, matchesShortcut } from "@/lib/shortcuts";
import { registerCommand } from "@/lib/commands";
import { isTauri } from "@/lib/backend";
import type { DocumentRecord } from "@/lib/documents";
import { pickPdfs } from "./add-pdf";
import { PdfViewer } from "./pdf-viewer";
import { PdfQuoteControls } from "./pdf-quote-controls";
import { ToolButton } from "./ui/tool-button";

const clampWidth = (width: number) => Math.max(320, Math.min(1000, width));
const paneWidth = (width: number) => `min(${width}px, max(320px, 65vw))`;

// The module's files, as the right panel shows them before one is picked.
function FileList({ moduleId, docs }: { moduleId: string; docs: DocumentRecord[] }) {
  const canAdd = isTauri();
  return <>
    <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-1.5">
      <span className="min-w-0 flex-1 truncate px-1.5 text-sm font-medium">Files</span>
      {canAdd && <ToolButton label="Add PDF" onClick={() => pickPdfs(moduleId)}><Plus /></ToolButton>}
      <ToolButton label="Close" onClick={() => updatePdfPane(moduleId, { open: false })}><X /></ToolButton>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {docs.length ? <ul className="grid gap-0.5">{docs.map(doc => <li key={doc.id}>
        <button type="button" onClick={() => openPdfPane(moduleId, doc.id)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{documentName(doc.name)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{!doc.available ? "Downloading" : doc.pageCount === null ? "PDF" : `${doc.pageCount} pages`}</span>
        </button>
      </li>)}</ul> : <p className="px-2 py-6 text-center text-sm text-muted-foreground">
        No PDFs in this module yet{canAdd && <>. <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => pickPdfs(moduleId)}>Add one</button></>}.
      </p>}
    </div>
  </>;
}

export function NoteWithPdfs({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  const { data: docs = [] } = useDocuments(moduleId);
  const pane = usePdfPane(moduleId);
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointer: number; element: HTMLDivElement; width: number; right: number; left: number; dividerWidth: number; maxWidth: number; cleanup: () => void } | null>(null);
  const finishResize = useCallback((commit = true) => {
    const drag = resize.current;
    if (!drag) return;
    resize.current = null;
    drag.cleanup();
    if (drag.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
    if (commit) updatePdfPane(moduleId, { width: drag.width });
  }, [moduleId]);
  useEffect(() => () => finishResize(false), [finishResize, pane.open]);
  // A remembered file that was since deleted falls back to the list.
  const active = docs.find(doc => doc.id === pane.active);
  const open = pane.open;
  useEffect(() => {
    document.documentElement.style.setProperty("--pdf-pane-width", open ? paneWidth(pane.width) : "0px");
    return () => { document.documentElement.style.removeProperty("--pdf-pane-width"); };
  }, [open, pane.width]);
  useEffect(() => registerCommand({ id: "pdf.toggle-pane", title: "Toggle files panel", keywords: ["pdf"],
    run: () => updatePdfPane(moduleId, { open: !pane.open }) }), [moduleId, pane.open]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, action("pdf.toggle-pane").keys) || !acceptsPdfShortcut(event, [root.current])) return;
      event.preventDefault(); event.stopPropagation();
      updatePdfPane(moduleId, { open: !pane.open });
    };
    window.addEventListener("keydown", toggle, true);
    return () => window.removeEventListener("keydown", toggle, true);
  }, [moduleId, pane.open]);
  return <div ref={root} data-pdf-note={moduleId} className="relative flex h-full min-h-0 flex-col"><PdfQuoteControls moduleId={moduleId} /><div className="note-with-pdfs flex min-h-0 min-w-0 flex-1">
    <div className="app-scroll-container min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">{children}</div>
    {open && <>
      <div role="separator" aria-label="Resize files panel" aria-orientation="vertical" aria-valuenow={pane.width} aria-valuemin={320} aria-valuemax={1000} tabIndex={0} className="relative w-1 shrink-0 touch-none cursor-col-resize bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none" onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); finishResize(false); updatePdfPane(moduleId, { width: clampWidth(pane.width + (event.key === "ArrowLeft" ? 20 : -20)) }); }
      }} onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || resize.current) return;
        event.preventDefault(); event.stopPropagation();
        const element = event.currentTarget;
        const parent = element.parentElement;
        const preview = guide.current;
        if (!parent || !preview) return;
        const bounds = element.getBoundingClientRect();
        const right = parent.getBoundingClientRect().right;
        preview.style.transform = "translate3d(0, 0, 0)";
        preview.hidden = false;
        element.setPointerCapture(event.pointerId);
        // Override explicit textLayer selection rules too, including WebKit's.
        // Removing this sheet restores existing styles without rewriting them.
        const sheet = document.createElement("style");
        sheet.textContent = "html, html body, html body * { user-select: none !important; -webkit-user-select: none !important; cursor: col-resize !important; }";
        document.head.append(sheet);
        const preventSelection = (event: Event) => event.preventDefault();
        document.addEventListener("selectstart", preventSelection, true);
        document.addEventListener("dragstart", preventSelection, true);
        resize.current = { pointer: event.pointerId, element, width: pane.width, right, left: bounds.left, dividerWidth: bounds.width,
          maxWidth: Math.max(320, window.innerWidth * 0.65), cleanup: () => {
          preview.hidden = true;
          preview.style.removeProperty("transform");
          sheet.remove();
          document.removeEventListener("selectstart", preventSelection, true);
          document.removeEventListener("dragstart", preventSelection, true);
        } };
      }} onPointerMove={event => {
        const drag = resize.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        drag.width = clampWidth(drag.right - event.clientX);
        // Preview the final boundary without resizing either viewport or canvas.
        const offset = drag.right - Math.min(drag.width, drag.maxWidth) - drag.dividerWidth - drag.left;
        if (guide.current) guide.current.style.transform = `translate3d(${offset}px, 0, 0)`;
      }} onPointerUp={event => {
        if (resize.current?.pointer !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation(); finishResize();
      }} onPointerCancel={event => { if (resize.current?.pointer === event.pointerId) finishResize(false); }}
      onLostPointerCapture={event => { if (resize.current?.pointer === event.pointerId) finishResize(false); }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
        <div ref={guide} hidden aria-hidden="true" className="pointer-events-none absolute inset-0 z-50 bg-primary shadow-sm" style={{ transition: "none", willChange: "transform" }} />
      </div>
      <aside aria-label="Files" className="flex min-h-0 shrink-0 flex-col bg-background" style={{ width: paneWidth(pane.width) }}>
        {active ? <div className="min-h-0 flex-1"><PdfViewer key={active.id} doc={active}
          leading={<>
            <ToolButton label="All files" onClick={() => updatePdfPane(moduleId, { active: null })}><ChevronLeft /></ToolButton>
            <span className="min-w-0 truncate text-sm">{documentName(active.name)}</span>
          </>}
          trailing={<>
            <ToolButton label="Open full screen" onClick={() => void navigate({ to: "/files/$documentId", params: { documentId: active.id } })}><Maximize2 /></ToolButton>
            <ToolButton label="Close" onClick={() => updatePdfPane(moduleId, { open: false })}><X /></ToolButton>
          </>} /></div> : <FileList moduleId={moduleId} docs={docs} />}
      </aside>
    </>}
  </div></div>;
}
