import { Toaster } from "@/components/ui/sonner";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useBlocker } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { usePdfQuoteNavigation } from "@/lib/pdf-quote-navigation";
import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { HeadingFold, getFoldedIds } from "@/lib/heading-fold";
import { SectionFocus, getFocusedSectionRange } from "@/lib/section-focus";
import { SavedImage, InlineImage } from "@/lib/editor-schema/images";
import "@/App.css";
const HeadingIdentity = Extension.create({ name: "headingIdentity", addGlobalAttributes: () => [{ types: ["heading"], attributes: { "data-toc-id": { default: null } } }] });
const heading = (text: string, level: number) => ({ type: "heading", attrs: { level, "data-toc-id": text }, content: [{ type: "text", text }] });
const image = (imageId: string, inline = false) => ({ type: inline ? "inlineImage" : "image", attrs: { imageId, src: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="blue"/></svg>') } });
function Controls() {
  const reveal = usePdfQuoteNavigation("module-one");
  return <header><button onClick={() => reveal("quote-block")}>Find block quote</button><button onClick={() => reveal("quote-inline")}>Find inline quote</button></header>;
}
function Note() {
  const { moduleId } = noteRoute.useParams();
  const { setActiveEditor } = useActiveEditor();
  const [ready, setReady] = useState(false);
  const editor = useEditor({ extensions: [StarterKit, HeadingIdentity, HeadingFold, SectionFocus, SavedImage, InlineImage], content: { type: "doc", content: [heading("Other", 1), { type: "paragraph", content: [{ type: "text", text: "Other section" }] }, heading("Outer", 1), heading("Inner", 2), ...Array.from({ length: 45 }, () => ({ type: "paragraph", content: [{ type: "text", text: "Filler content" }] })), image("quote-block"), { type: "paragraph", content: [{ type: "text", text: "Inline " }, image("quote-inline", true)] }] } });
  useEffect(() => {
    if (!editor) return;
    Object.assign(window, { quoteTest: { editor, setReady, getFoldedIds, getFocusedSectionRange } });
    setActiveEditor({ editor, moduleId, isReady: ready, insertQuote: async () => {} });
    return () => setActiveEditor(null);
  }, [editor, moduleId, ready, setActiveEditor]);
  return <NoteWithPdfs moduleId={moduleId}><EditorContent editor={editor} /></NoteWithPdfs>;
}
function Root() {
  const [blocked, setBlocked] = useState(false);
  useBlocker({ shouldBlockFn: () => blocked });
  useEffect(() => { Object.assign(window, { setQuoteBlocked: setBlocked }); }, []);
  return <QueryClientProvider client={client}><ActiveEditorProvider><Controls /><div style={{ height: 360 }}><Outlet /></div></ActiveEditorProvider></QueryClientProvider>;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({ component: Root });
let failRoute = false;
Object.assign(window, { setQuoteRouteError: (failed: boolean) => { failRoute = failed; } });
const noteRoute = createRoute({ getParentRoute: () => root, path: "/$moduleId/", component: Note, beforeLoad: () => { if (failRoute) throw new Error("Note unavailable"); } });
const files = createRoute({ getParentRoute: () => root, path: "/files/$documentId", component: () => <p>Fullscreen PDF</p> });
const router = createRouter({ routeTree: root.addChildren([noteRoute, files]), history: createMemoryHistory({ initialEntries: ["/module-one"] }) });
Object.assign(window, { quoteRouter: router });
createRoot(document.getElementById("root")!).render(<><Toaster /><RouterProvider router={router} /></>);
