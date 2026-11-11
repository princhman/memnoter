import "@/App.css";
import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { noteExtensions } from "@/lib/editor-schema";
import { Editor } from "@tiptap/core";
import { PdfTextQuote } from "@/components/pdf-text-quote";
import { ActiveEditorProvider, useActiveEditor } from "@/lib/active-editor-context";
import { PdfQuoteControls } from "@/components/pdf-quote-controls";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { useNoteDocument } from "@/lib/note-document";
import { queryClient } from "@/lib/query-client";
import { flushAll, imageStatusStore } from "@/lib/write-lifecycle";

import { pendingPdfQuote } from "@/lib/pending-pdf-quote";

function Fixture() {
  const [readerOpen, setReaderOpen] = useState(!location.search.includes("late-reader"));
  const owner = useNoteDocument("quote-module");
  const { setActiveEditor } = useActiveEditor();
  const editor = useEditor({ extensions: noteExtensions({ document: owner.yDoc, ui: { pdfTextQuote: PdfTextQuote } }) });
  useLayoutEffect(() => { owner.editorRef.current = editor; }, [editor]);
  useEffect(() => {
    if (!editor || !owner.isSuccess) return;
    if (readerOpen) setActiveEditor({ moduleId: "quote-module", editor, isReady: true, insertQuote: owner.insertQuote, insertTextQuote: owner.insertTextQuote });
    Object.assign(window, { textQuoteTest: { Editor, noteExtensions, editor, owner, Y, flushAll, imageStatusStore, pendingPdfQuote } });
  }, [editor, owner.isSuccess, owner.insertQuote, owner.insertTextQuote, setActiveEditor, readerOpen]);
  return <main className="relative h-[600px]"><EditorContent editor={editor} />{readerOpen ? <PdfQuoteControls moduleId="quote-module" /> : <button onClick={() => setReaderOpen(true)}>Open reader</button>}</main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><ActiveEditorProvider><Fixture /></ActiveEditorProvider></QueryClientProvider>);
