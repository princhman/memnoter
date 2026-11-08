import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, FileText, Maximize2, Plus, X } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { documentName } from "@/lib/pdf-state";
import { openPdfPane, updatePdfPane, usePdfPane } from "@/lib/pdf-pane";
import { registerCommand } from "@/lib/commands";
import { isTauri } from "@/lib/backend";
import type { DocumentRecord } from "@/lib/documents";
import { pickPdfs } from "./add-pdf";
import { PdfViewer } from "./pdf-viewer";
import { ToolButton } from "./ui/tool-button";

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
  // A remembered file that was since deleted falls back to the list.
  const active = docs.find(doc => doc.id === pane.active);
  const open = pane.open;
  useEffect(() => {
    document.documentElement.style.setProperty("--pdf-pane-width", open ? paneWidth(pane.width) : "0px");
    return () => { document.documentElement.style.removeProperty("--pdf-pane-width"); };
  }, [open, pane.width]);
  useEffect(() => registerCommand({ id: "pdf.toggle-pane", title: "Toggle files panel", keywords: ["pdf"],
    run: () => updatePdfPane(moduleId, { open: !pane.open }) }), [moduleId, pane.open]);
  return <div className="note-with-pdfs flex h-full min-h-0 min-w-0">
    <div className="app-scroll-container min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-8">{children}</div>
    {open && <>
      <div role="separator" aria-label="Resize files panel" aria-orientation="vertical" aria-valuenow={pane.width} tabIndex={0} className="w-1 shrink-0 touch-none cursor-col-resize bg-border hover:bg-primary focus-visible:bg-primary focus-visible:outline-none" onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); updatePdfPane(moduleId, { width: Math.max(320, Math.min(1000, pane.width + (event.key === "ArrowLeft" ? 20 : -20))) }); }
      }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePdfPane(moduleId, { width: Math.max(320, Math.min(1000, event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX)) });
      }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
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
  </div>;
}
