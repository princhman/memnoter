import { createFileRoute, Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useDocuments } from "@/lib/use-documents";
import { useModules } from "@/lib/modules";
import { documentName } from "@/lib/pdf-state";
import { DocumentActions } from "@/components/document-actions";
import { dropPdfs, pickPdfs } from "@/components/add-pdf";
import { isTauri } from "@/lib/backend";
export const Route = createFileRoute("/files/")({
  validateSearch: (search: Record<string, unknown>): { module?: string } => typeof search.module === "string" ? { module: search.module } : {},
  component: Files,
});
function Files() {
  const { module: moduleId } = Route.useSearch();
  const { data: docs = [], error } = useDocuments(moduleId);
  const { data: modules = [] } = useModules();
  return <div className="min-h-full" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={event => { event.preventDefault(); dropPdfs(Array.from(event.dataTransfer.files), moduleId); }}>
    <div className="mx-auto grid max-w-md gap-6 py-8">
      {error && <p role="alert" className="text-center text-sm text-destructive">{error.message}</p>}
      {!docs.length && <p className="text-center text-sm text-muted-foreground">Drop PDFs here{isTauri() && <>, or <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => pickPdfs(moduleId)}>choose files</button></>}.</p>}
      {docs.length > 0 && modules.filter(module => !moduleId || module.id === moduleId).map(module => <section key={module.id} onDrop={event => { event.preventDefault(); event.stopPropagation(); dropPdfs(Array.from(event.dataTransfer.files), module.id); }}>
        <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{module.name}</h2>
        <ul className="grid gap-0.5">{docs.filter(doc => doc.moduleId === module.id).map(doc => <li key={doc.id}><DocumentActions doc={doc}>
          <Link to="/files/$documentId" params={{ documentId: doc.id }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
            <FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{documentName(doc.name)}</span><span className="shrink-0 text-xs text-muted-foreground">{!doc.available ? "Downloading" : doc.pageCount === null ? "PDF" : `${doc.pageCount} pages`}</span>
          </Link>
        </DocumentActions></li>)}</ul>
      </section>)}
    </div>
  </div>;
}
