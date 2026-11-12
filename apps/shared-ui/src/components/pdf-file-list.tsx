import { FileText, Plus } from "lucide-react";
import { isNativeHost, isTauri } from "@/lib/backend";
import type { DocumentRecord } from "@/lib/documents";
import { documentName } from "@/lib/pdf-state";
import { openPdfPane } from "@/lib/pdf-pane";
import { pickPdfs } from "./add-pdf";
import { ToolButton } from "./ui/tool-button";

// The module's files, as the right panel shows them before one is picked.
export function PdfFileList({ moduleId, docs, hideHeader = false }: { moduleId: string; docs: DocumentRecord[]; hideHeader?: boolean }) {
  const canAdd = isTauri() || isNativeHost();
  return <>
    {!hideHeader && <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-1.5">
      <span className="min-w-0 flex-1 truncate px-1.5 text-sm font-medium">Files</span>
      {canAdd && <ToolButton label="Add PDF" onClick={() => pickPdfs(moduleId)}><Plus /></ToolButton>}
    </div>}
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
