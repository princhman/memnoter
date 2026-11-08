import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { imageOperation } from "@/lib/write-lifecycle";
import { PdfQuoteControls } from "@/components/pdf-quote-controls";
import "@/App.css";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { PdfSourceCaption } from "@/components/pdf-source-caption";
import { pdfPageRequest, usePdfPane } from "@/lib/pdf-pane";
import { useSelector } from "@tanstack/react-store";

const source = { documentId: "pdf-one", page: 7, name: "/private/docs/Lecture.pdf", region: { x: 0, y: 0, width: 1, height: 1 } };
function Captions() {
  return <div><PdfSourceCaption value={source} /><PdfSourceCaption value={{ ...source, documentId: "missing", name: "Deleted.pdf" }} /><PdfSourceCaption value={{ ...source, page: -1, name: "Invalid.pdf" }} /></div>;
}
function Module() {
  const pane = usePdfPane("module-one");
  const request = useSelector(pdfPageRequest, state => state);
  return <><Captions /><output>{JSON.stringify({ pane, request })}</output></>;
}
const HeadingIdentity = Extension.create({
  name: "headingIdentity",
  addGlobalAttributes() { return [{ types: ["heading"], attributes: { "data-toc-id": { default: null } } }]; },
});
function Picker() {
  const { setActiveEditor } = useActiveEditor();
  const [moduleId, setModuleId] = useState("module-one");
  const editor = useEditor({ extensions: [StarterKit, HeadingIdentity], content: {
    type: "doc", content: [
      { type: "heading", attrs: { level: 1, "data-toc-id": "stable-section" }, content: [{ type: "text", text: "First section" }] },
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
    ],
  } });
  useEffect(() => {
    if (!editor) return;
    const calls: unknown[] = [];
    const control = { rejectAdmission: false };
    setActiveEditor({ editor, moduleId, isReady: true, insertQuote: async (_editor, _file, _source, target) => { if (control.rejectAdmission) throw new Error("Saving is temporarily unavailable"); calls.push(target); } });
    Object.assign(window, { pickerTest: { editor, calls, control, unrelatedFailure: () => imageOperation(async () => { throw new Error("Unrelated image failed"); }).catch(() => {}), setModuleId, pendingPdfQuote, draft: () => pendingPdfQuote.setState(() => ({ moduleId: "module-one", file: new File(["png"], "quote.png"), source, section: true, status: "draft" })) } });
    return () => setActiveEditor(null);
  }, [editor, moduleId, setActiveEditor]);
  return <><EditorContent editor={editor} /><PdfQuoteControls moduleId="module-one" /></>;
}
const root = createRootRoute({ component: Outlet });
const module = createRoute({ getParentRoute: () => root, path: "/$moduleId/", component: Module });
const files = createRoute({ getParentRoute: () => root, path: "/files/$documentId", component: Captions, validateSearch: (search: Record<string, unknown>) => ({ page: Number(search.page) || undefined }) });
const router = createRouter({ routeTree: root.addChildren([module, files, createRoute({ getParentRoute: () => root, path: "/picker", component: () => <ActiveEditorProvider><Picker /></ActiveEditorProvider> })]), history: createMemoryHistory({ initialEntries: ["/module-one"] }) });
Object.assign(window, { navigationTest: { router, pdfPageRequest } });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
