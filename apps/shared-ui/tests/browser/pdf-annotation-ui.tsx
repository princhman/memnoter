import "@/App.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { exclusiveWrite } from "@/lib/write-lifecycle";
import { PdfViewer } from "@/components/pdf-viewer";

function Fixture() {
  const [documentId, setDocumentId] = useState("text-pdf");
  const pending = useSelector(pendingPdfQuote, value => value);
  return <>
    <button onClick={() => { void exclusiveWrite(() => new Promise(resolve => setTimeout(resolve, 1000))); }}>Block writes briefly</button>
    <p id="outside">Outside text stays outside quotes</p>
    <button onClick={() => setDocumentId("replacement-pdf")}>Replace document</button>
    <button onClick={() => pendingPdfQuote.setState(() => null)}>Clear quote</button>
    <button onClick={() => pendingPdfQuote.setState(() => ({ id: crypto.randomUUID(), kind: "image", moduleId: "other", status: "draft", file: new File(["image"], "quote.png"), source: { documentId: "other", name: "Other.pdf", page: 1, region: { x: 0, y: 0, width: 1, height: 1 } } }))}>Stage image</button>
    <output id="text-draft" hidden>{JSON.stringify(pending)}</output>
    <div id="viewer" style={{ height: 900 }}><PdfViewer doc={{ id: documentId, moduleId: "module", moduleName: "Module", name: "Selection.pdf", size: 1000, pageCount: 3, createdAt: 0, available: true }} /></div>
  </>;
}
const route = createRootRoute({ component: Fixture });
const router = createRouter({ routeTree: route });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><ActiveEditorProvider><RouterProvider router={router} /></ActiveEditorProvider></QueryClientProvider>);
