import "@/App.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import FindAndReplace from "@tiptap/extension-find-and-replace";
import { FindBar } from "@/components/find-bar";
import StarterKit from "@tiptap/starter-kit";
import { useSelector } from "@tanstack/react-store";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { NoteWithPdfs } from "@/components/note-with-pdfs";
import { queryClient } from "@/lib/query-client";
import { FilesPanelButton } from "@/components/pdf-header-actions";
import { updatePdfPane } from "@/lib/pdf-pane";
import { pendingPdfQuote } from "@/lib/pending-pdf-quote";
function ActiveFind({ editor }: { editor: Editor | null }) {
  const { setActiveEditor } = useActiveEditor();
  useEffect(() => {
    if (!editor) return;
    const unused = async () => { throw new Error("Quote insertion is not used in this fixture"); };
    setActiveEditor({ editor, moduleId: "resize-module", isReady: true, insertQuote: unused, insertTextQuote: unused });
    return () => setActiveEditor(null);
  }, [editor, setActiveEditor]);
  return <FindBar />;
}
function Fixture() {
  const [mounted, setMounted] = useState(true);
  const pending = useSelector(pendingPdfQuote, value => value);
  const editor = useEditor({ extensions: [StarterKit, FindAndReplace], content: "<p>Remember this selected note text while resizing the files panel.</p>" });
  return <ActiveEditorProvider>
    <button onClick={() => setMounted(value => !value)}>Toggle pane mount</button>
    <button onClick={() => updatePdfPane("resize-module", { open: true })}>Open pane</button>
    <ActiveFind editor={editor} /><FilesPanelButton /><output id="pending">{pending ? "quote" : "none"}</output>
    <div style={{ height: 700 }}>{mounted && <NoteWithPdfs moduleId="resize-module"><EditorContent editor={editor} /></NoteWithPdfs>}</div>
    <p id="outside">Text remains selectable after resize cleanup.</p>
  </ActiveEditorProvider>;
}
const route = createRootRoute({ component: Fixture });
const note = createRoute({ getParentRoute: () => route, path: "/$moduleId", component: () => null });
const router = createRouter({ routeTree: route.addChildren([note]), history: createMemoryHistory({ initialEntries: ["/resize-module"] }) });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
