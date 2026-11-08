import "@/App.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useSelector } from "@tanstack/react-store";
import { ActiveEditorProvider } from "@/lib/active-editor-context";
import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { queryClient } from "@/lib/query-client";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
function Fixture() {
  const [mounted, setMounted] = useState(true);
  const pending = useSelector(pendingPdfQuote, value => value);
  const editor = useEditor({ extensions: [StarterKit], content: "<p>Remember this selected note text while resizing the files panel.</p>" });
  return <ActiveEditorProvider>
    <button onClick={() => setMounted(value => !value)}>Toggle pane mount</button>
    <output id="pending">{pending ? "quote" : "none"}</output>
    <div style={{ height: 700 }}>{mounted && <NoteWithPdfs moduleId="resize-module"><EditorContent editor={editor} /></NoteWithPdfs>}</div>
    <p id="outside">Text remains selectable after resize cleanup.</p>
  </ActiveEditorProvider>;
}
const route = createRootRoute({ component: Fixture });
const router = createRouter({ routeTree: route });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
