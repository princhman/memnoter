import "@/App.css";
import { useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { Extension } from "@tiptap/core";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { useNoteDocument } from "@/lib/note-document";
import { queryClient } from "@/lib/query-client";
import { SavedImage, InlineImage } from "@/lib/editor-schema/images";
import { cropPdfCanvas, normalizePdfRegion } from "@/lib/pdf-quote";
import { retryFailedImages, discardFailedImages, flushAll, imageStatusStore } from "@/lib/write-lifecycle";
import { PdfRegionSelection } from "@/components/pdf-region-selection";

import { pendingPdfQuote } from "@/lib/pending-pdf-quote";

const HeadingIdentity = Extension.create({
  name: "headingIdentity",
  addGlobalAttributes() { return [{ types: ["heading"], attributes: { "data-toc-id": { default: null } } }]; },
});
function Fixture() {
  const owner = useNoteDocument("quote-module");
  const editor = useEditor({ extensions: [StarterKit.configure({ undoRedo: false }), HeadingIdentity, SavedImage, InlineImage, Collaboration.configure({ document: owner.yDoc })] });
  useLayoutEffect(() => { owner.editorRef.current = editor; }, [editor]);
  useEffect(() => {
    if (!editor || !owner.isSuccess) return;
    Object.assign(window, { quoteTest: { editor, owner, Y, cropPdfCanvas, normalizePdfRegion, retryFailedImages, discardFailedImages, flushAll, imageStatusStore, pendingPdfQuote } });
  }, [editor, owner]);
  return <><EditorContent editor={editor} /><div style={{ position: "relative", width: 200, height: 100 }}><PdfRegionSelection onCancel={() => Object.assign(window, { cancelled: true })} onSelect={region => Object.assign(window, { selectedRegion: region })} /></div></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
