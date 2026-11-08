import "@/App.css";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useNavigate } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { FilesPanelButton } from "@/components/pdf-header-actions";
import { PdfViewer } from "@/components/pdf-viewer";
import { queryClient } from "@/lib/query-client";
import { useCommands } from "@/lib/commands";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
import { useSelector } from "@tanstack/react-store";
const doc = { id: "shortcut-pdf", moduleId: "module", moduleName: "Module", name: "Shortcuts.pdf", size: 1000, pageCount: 6, createdAt: 0, available: true };
function Shell() {
  const navigate = useNavigate();
  const commands = useCommands();
  const pending = useSelector(pendingPdfQuote, state => state);
  return <ActiveEditorProvider>
    <button onClick={() => void navigate({ to: "/files/$documentId", params: { documentId: doc.id } })}>Reader</button>
    <button onClick={() => void navigate({ to: "/away" })}>Away</button>
    <button onClick={() => void navigate({ to: "/$moduleId", params: { moduleId: "module" } })}>Note</button>
    <input aria-label="Unrelated input" /><div role="dialog"><button>Dialog action</button></div><div role="menu"><button>Menu action</button></div>
    <header><FilesPanelButton /><div id="pdf-toolbar" /></header>
    <output id="commands" hidden>{JSON.stringify(commands.map(({ id, shortcut }) => ({ id, shortcut })))}</output>
    <output id="pending" hidden>{pending ? JSON.stringify({ section: pending.section, status: pending.status }) : "none"}</output>
    <button onClick={() => pendingPdfQuote.setState(() => null)}>Clear quote</button><Outlet />
  </ActiveEditorProvider>;
}
function Note() {
  const editor = useEditor({ extensions: [StarterKit], content: "<p>Remember this note cursor.</p>" });
  return <div style={{ height: 650 }}><NoteWithPdfs moduleId="module"><EditorContent editor={editor} /><input aria-label="Find in note" /></NoteWithPdfs></div>;
}
const root = createRootRoute({ component: Shell });
const note = createRoute({ getParentRoute: () => root, path: "/$moduleId", component: Note });
const reader = createRoute({ getParentRoute: () => root, path: "/files/$documentId", component: () => <div style={{ height: 650 }}><PdfViewer doc={doc} fullscreen /></div> });
const away = createRoute({ getParentRoute: () => root, path: "/away", component: () => <p>Other context</p> });
const router = createRouter({ routeTree: root.addChildren([note, reader, away]), history: createMemoryHistory({ initialEntries: ["/module"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
