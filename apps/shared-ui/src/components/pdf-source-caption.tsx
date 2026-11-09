import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { parsePdfSource } from "@/lib/pdf-quote";
import { listDocuments } from "@/lib/documents";
import { openPdfPane, requestPdfPage } from "@/lib/pdf-pane";

export function PdfSourceCaption({ value }: { value: unknown }) {
  const source = parsePdfSource(value);
  // Native editor hosts do not mount the desktop router.
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setError("");
    setOpening(false);
    return () => { request.current++; };
  }, [source?.documentId, source?.page]);
  if (!source) return null;
  const name = source.name.split(/[\\/]/).pop()?.trim() || "PDF";
  const open = async () => {
    const token = ++request.current;
    setError("");
    if (!router) {
      setError("Source links are available in the desktop app. Your saved quote is still available here.");
      return;
    }
    const location = router.state.location;
    setOpening(true);
    try {
      const docs = await listDocuments();
      if (request.current !== token || router.state.location !== location) return;
      const doc = docs.find(doc => doc.id === source.documentId);
      if (!doc) { setError("Source PDF is no longer available. Your saved quote is still available."); return; }
      const sameModule = router.state.matches.some(match => "moduleId" in match.params && match.params.moduleId === doc.moduleId);
      if (sameModule) {
        requestPdfPage(doc.id, source.page);
        openPdfPane(doc.moduleId, doc.id);
      } else {
        await router.navigate({ to: "/files/$documentId", params: { documentId: doc.id }, search: { page: source.page } });
        // A reader may already have this URL while scrolled to another page.
        if (request.current === token && router.state.location.search.page === source.page &&
          router.state.matches.some(match => "documentId" in match.params && match.params.documentId === doc.id)) {
          requestPdfPage(doc.id, source.page);
        }
      }
    } catch {
      if (request.current === token && router.state.location === location) setError("Could not open source PDF. Try again.");
    } finally {
      if (request.current === token) setOpening(false);
    }
  };
  return <span className="block py-1 text-xs text-muted-foreground" contentEditable={false}>
    <button type="button" disabled={opening} className="text-left underline underline-offset-2 hover:text-foreground disabled:opacity-50" onClick={() => void open()}>{name}, page {source.page}</button>
    {error && <span role="status" className="ml-2">{error}</span>}
  </span>;
}
