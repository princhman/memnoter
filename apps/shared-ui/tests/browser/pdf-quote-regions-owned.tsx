import "@/App.css";
import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { PdfTextQuote } from "@/lib/editor-schema/pdf-text-quotes";
import { PdfQuoteNavigation, usePdfQuoteNavigation } from "@/lib/pdf-quote-navigation";
import { HeadingFold, getFoldedIds } from "@/lib/heading-fold";
import { SectionFocus, getFocusedSectionRange } from "@/lib/section-focus";
import Collaboration from "@tiptap/extension-collaboration";
import { QueryClientProvider } from "@tanstack/react-query";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { useNoteDocument } from "@/lib/note-document";
import { queryClient } from "@/lib/query-client";
import { SavedImage, InlineImage } from "@/lib/editor-schema/images";
import { usePdfQuoteRegions } from "@/lib/use-pdf-quote-regions";
import { PdfQuoteRegions } from "@/components/pdf-quote-regions";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { saveQueue } from "@/lib/saves";

const HeadingIdentity = Extension.create({ name: "headingIdentity", addGlobalAttributes: () => [{ types: ["heading"], attributes: { "data-toc-id": { default: null } } }] });

function Note() {
  const owner = useNoteDocument("regions-module");
  const { setActiveEditor } = useActiveEditor();
  const editor = useEditor({ extensions: [StarterKit.configure({ undoRedo: false }), SavedImage, InlineImage, PdfTextQuote, HeadingIdentity, HeadingFold, SectionFocus, Collaboration.configure({ document: owner.yDoc })] });
  useLayoutEffect(() => { owner.editorRef.current = editor; }, [editor]);
  useEffect(() => {
    if (!editor) return;
    setActiveEditor({ moduleId: "regions-module", editor, isReady: owner.isSuccess, insertQuote: owner.insertQuote });
    Object.assign(window, { regionsEditor: editor, regionsView: { getFoldedIds, getFocusedSectionRange } });
    return () => setActiveEditor(null);
  }, [editor, owner.isSuccess, owner.insertQuote, setActiveEditor]);
  return <div className="app-scroll-container" style={{ height: 220, overflow: "auto" }}><EditorContent editor={editor} /></div>;
}
function Reader() {
  const navigate = usePdfQuoteNavigation("regions-module");
  const regions = usePdfQuoteRegions("regions-module", "pdf-one");
  const [scale, setScale] = useState(1);
  useEffect(() => { Object.assign(window, { regionsSnapshot: regions, setRegionScale: setScale }); }, [regions]);
  return <><output>{JSON.stringify([...regions])}</output>{[1, 2].map(page => <div key={page} id={`page-${page}`} style={{ position: "relative", width: 400 * scale, height: 200 * scale }}>
    <button style={{ position: "absolute", inset: 0 }} onClick={() => Object.assign(window, { pageClicked: true })}>Page {page}</button>
    <PdfQuoteRegions regions={regions.get(page)} onNavigate={navigate} />
  </div>)}</>;
}
function Fixture() {
  const [note, setNote] = useState(true);
  const [reader, setReader] = useState(true);
  useEffect(() => { Object.assign(window, { regionsTest: { setNote, setReader, pendingPdfQuote, saveQueue, queryClient } }); }, []);
  return <>{note && <Note />}{reader && <Reader />}<PdfQuoteNavigation moduleId="regions-module" /></>;
}
const root = createRootRoute({ component: Outlet });
const noteRoute = createRoute({ getParentRoute: () => root, path: "/$moduleId", component: Fixture });
const router = createRouter({ routeTree: root.addChildren([noteRoute]), history: createMemoryHistory({ initialEntries: ["/regions-module"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><ActiveEditorProvider><RouterProvider router={router} /></ActiveEditorProvider></QueryClientProvider>);
