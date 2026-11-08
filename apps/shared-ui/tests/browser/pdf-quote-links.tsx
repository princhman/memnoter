import "@/App.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { queryClient } from "@/lib/query-client";
import { SavedImage } from "@/lib/editor-schema/images";
import { PdfViewer } from "@/components/pdf-viewer";
import { PdfQuoteNavigation } from "@/lib/pdf-quote-navigation";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
const source = { documentId: "links-pdf", page: 1, name: "Links.pdf", region: { x: .1, y: .2, width: .8, height: .3 } };
const heading = (text: string) => ({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text }] });
const image = (imageId: string) => ({ type: "image", attrs: { fileId: "same-file", imageId, pdfSource: source } });
function Fixture() {
  const { setActiveEditor } = useActiveEditor();
  const [selected, setSelected] = useState("");
  const editor = useEditor({ extensions: [StarterKit, SavedImage], content: { type: "doc", content: [heading("Overview"), image("quote-first")] },
    onSelectionUpdate: ({ editor }) => setSelected("node" in editor.state.selection ? String(editor.state.selection.node.attrs.imageId) : "") });
  useEffect(() => {
    if (!editor) return;
    setActiveEditor({ moduleId: "links-module", editor, isReady: true, insertQuote: async () => {} });
    return () => setActiveEditor(null);
  }, [editor, setActiveEditor]);
  return <><output aria-label="Selected quote">{selected}</output>
    <button onClick={() => { editor?.commands.setTextSelection(0); setSelected(""); window.getSelection()?.removeAllRanges(); }}>Reset target</button>
    <button onClick={() => editor?.commands.insertContentAt(editor.state.doc.content.size, [heading("Detailed analysis"), image("quote-second")])}>Add another use</button>
    <button onClick={() => pendingPdfQuote.setState(() => ({ id: crypto.randomUUID(), kind: "image", moduleId: "links-module", source: { ...source, region: { x: .1, y: .6, width: .8, height: .2 } }, file: new File([], "draft.png"), status: "draft" }))}>Stage pending</button>
    <div id="viewer" style={{ height: 550 }}><PdfViewer doc={{ id: "links-pdf", moduleId: "links-module", moduleName: "Links", name: "Links.pdf", size: 1000, pageCount: 1, available: true, createdAt: 0 }} /></div>
    <PdfQuoteNavigation moduleId="links-module" />
  </>;
}
const root = createRootRoute({ component: Outlet });
const module = createRoute({ getParentRoute: () => root, path: "/$moduleId", component: Fixture });
const router = createRouter({ routeTree: root.addChildren([module]), history: createMemoryHistory({ initialEntries: ["/links-module"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><ActiveEditorProvider><RouterProvider router={router} /></ActiveEditorProvider></QueryClientProvider>);
