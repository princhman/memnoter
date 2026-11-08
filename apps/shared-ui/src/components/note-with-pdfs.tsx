import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Maximize2, X } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { documentName } from "@/lib/pdf-state";
import { openPdfPane, updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { registerCommand } from "@/lib/commands";
import { PdfViewer } from "./pdf-viewer";
import { ToolButton } from "./ui/tool-button";
import { Button } from "./ui/button";
export function NoteWithPdfs({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  const { data: docs = [] } = useDocuments(moduleId);
  const pane = usePdfPane(moduleId);
  const navigate = useNavigate();
  const active = docs.find(doc => doc.id === pane.active) ?? docs[0];
  const open = pane.open && !!active;
  useEffect(() => {
    document.documentElement.style.setProperty("--pdf-pane-width", open ? `min(${pane.width}px, max(320px, 65vw))` : "0px");
    return () => { document.documentElement.style.removeProperty("--pdf-pane-width"); };
  }, [open, pane.width]);
  useEffect(() => {
    if (!docs.length) return;
    return registerCommand({ id: "pdf.toggle-pane", title: "Toggle PDF pane", run: () => updatePdfPane(moduleId, { open: !pane.open }) });
  }, [docs.length, moduleId, pane.open]);
  return <div className="note-with-pdfs flex h-full min-h-0 min-w-0">
    <div className="app-scroll-container min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">
      {!!docs.length && <div className="mx-auto mb-4 flex max-w-3xl flex-wrap gap-1" aria-label="Module PDFs">{docs.map(doc => <Button key={doc.id} size="sm" variant="ghost" className="h-6 max-w-48 gap-1 px-2 text-xs text-muted-foreground" onClick={() => openPdfPane(moduleId, doc.id)}><FileText className="size-3 shrink-0" /><span className="truncate">{documentName(doc.name)}</span></Button>)}</div>}
      {children}
    </div>
    {open && <>
      <div role="separator" aria-label="Resize PDF pane" aria-orientation="vertical" aria-valuenow={pane.width} tabIndex={0} className="w-1 shrink-0 touch-none cursor-col-resize bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none" onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); updatePdfPane(moduleId, { width: Math.max(320, Math.min(1000, pane.width + (event.key === "ArrowLeft" ? 20 : -20))) }); }
      }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePdfPane(moduleId, { width: Math.max(320, Math.min(1000, event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX)) });
      }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <aside aria-label="PDF pane" className="flex min-h-0 shrink-0 flex-col" style={{ width: `min(${pane.width}px, max(320px, 65vw))` }}>
        <div className="flex shrink-0 items-center gap-1 px-1 py-1">
          <div role="tablist" aria-label="Module PDFs" className="flex min-w-0 flex-1 overflow-x-auto">{docs.map(doc => <button type="button" role="tab" tabIndex={active.id === doc.id ? 0 : -1} aria-selected={active.id === doc.id} key={doc.id} className="max-w-40 shrink-0 truncate rounded px-2 py-1 text-xs hover:bg-accent aria-selected:bg-accent" onKeyDown={event => {
            const index = docs.findIndex(item => item.id === doc.id);
            const next = event.key === "ArrowRight" ? (index + 1) % docs.length : event.key === "ArrowLeft" ? (index + docs.length - 1) % docs.length : event.key === "Home" ? 0 : event.key === "End" ? docs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); openPdfPane(moduleId, docs[next].id);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
          }} onClick={() => openPdfPane(moduleId, doc.id)}>{documentName(doc.name)}</button>)}</div>
          <ToolButton label="Open full screen" onClick={() => void navigate({ to: "/files/$documentId", params: { documentId: active.id } })}><Maximize2 /></ToolButton>
          <ToolButton label="Close PDF pane" onClick={() => updatePdfPane(moduleId, { open: false })}><X /></ToolButton>
        </div>
        <div className="min-h-0 flex-1"><PdfViewer key={active.id} doc={active} /></div>
      </aside>
    </>}
  </div>;
}
