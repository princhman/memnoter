import { createFileRoute } from "@tanstack/react-router";
import { useDocuments } from "@/lib/use-documents";
import { PdfViewer } from "@/components/pdf-viewer";
export const Route = createFileRoute("/files/$documentId")({ component: Reader });
function Reader() {
  const { documentId } = Route.useParams();
  const { data: docs, error } = useDocuments();
  const doc = docs?.find(doc => doc.id === documentId);
  return doc ? <PdfViewer key={doc.id} doc={doc} fullscreen /> : <p className="p-8 text-center text-sm text-muted-foreground">{error?.message ?? (docs ? "PDF not found" : "Loading PDF…")}</p>;
}
