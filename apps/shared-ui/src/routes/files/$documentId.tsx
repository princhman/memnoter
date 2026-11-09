import { createFileRoute } from "@tanstack/react-router";
import { useDocuments } from "@/lib/use-documents";
import { PdfViewer } from "@/components/pdf-viewer";
export const Route = createFileRoute("/files/$documentId")({
  validateSearch: (search: Record<string, unknown>): { page?: number } => {
    const value = typeof search.page === "string" && /^\d+$/.test(search.page) ? Number(search.page) : search.page;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? { page: value } : {};
  },
  component: Reader,
});
function Reader() {
  const { documentId } = Route.useParams();
  const { page } = Route.useSearch();
  const { data: docs, error } = useDocuments();
  const doc = docs?.find(doc => doc.id === documentId);
  return doc ? <PdfViewer key={`${doc.id}:${page ?? "saved"}`} doc={doc} fullscreen initialPage={page} /> : <p className="p-8 text-center text-sm text-muted-foreground">{error?.message ?? (docs ? "PDF not found" : "Loading PDF…")}</p>;
}
