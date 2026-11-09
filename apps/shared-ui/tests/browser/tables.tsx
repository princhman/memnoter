import { visibleNoteExtensions } from "../support/editor-ui";
import { importFolder } from "@/lib/import-module";
import { markdownToJSON } from "@/lib/markdown-paste";
import { call } from "@/lib/backend";
import { applySavedContent } from "@/lib/content";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { noteExtensions } from "@/lib/editor-schema";
import { extractCards } from "@/lib/cards";
import { extractFromDoc, extractFromYDoc } from "@/lib/search-text";
import { execEditor, editorState } from "@/editor-host/commands";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

const document = new Y.Doc();
Object.assign(window, { pickedImages: [] });
function TablesEditor() {
  // Records /image picks; uploads belong to the app shell.
  const insertImages = (_editor: unknown, files: File[]) => { (window as unknown as { pickedImages: string[] }).pickedImages.push(...files.map(file => file.name)); };
  const editor = useEditor({ extensions: visibleNoteExtensions({ document }, { insertImages }), onCreate: ({ editor }) => {
    Object.assign(window, {
      loadImported: async (saved: Parameters<typeof applySavedContent>[1]) => {
        const doc = new Y.Doc(); applySavedContent(doc, saved);
        const before = Array.from(Y.encodeStateAsUpdate(doc));
        const imported = new Editor({ element: window.document.getElementById("root")!.appendChild(window.document.createElement("div")), extensions: noteExtensions({ document: doc }) });
        await new Promise(resolve => setTimeout(resolve, 100));
        imported.state.doc.check();
        let images = 0, codeBlocks = 0, highlights = 0;
        imported.state.doc.descendants(n => { if (n.type.name === "image") images++; if (n.type.name === "codeBlock") codeBlocks++; if (n.isText && n.marks.some(m => m.type.name === "highlight")) highlights++; });
        return { images, codeBlocks, highlights, changed: JSON.stringify(before) !== JSON.stringify(Array.from(Y.encodeStateAsUpdate(doc))) };
      },
      editor, importFolder, markdownToJSON, call, applySavedContent, Y, documentY: document, extractCards, extractFromDoc, extractFromYDoc, execEditor, editorState,
      stopCapture: () => yUndoPluginKey.getState(editor.state).undoManager.stopCapturing(),
      cloneEditor: (legacy = false) => {
        const clone = new Y.Doc();
        Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
        const initialBytes = Array.from(Y.encodeStateAsUpdate(clone));
        const extensions = noteExtensions({ document: clone });
        const other = new Editor({ extensions: legacy
          ? extensions.filter(extension => !["table", "tableRow", "tableCell", "tableHeader", "details", "detailsSummary", "detailsContent"].includes(extension.name))
          : extensions });
        return { editor: other, document: clone, initialBytes };
      },
    });
  } });
  return <TooltipProvider><div style={{ width: 420, margin: 40 }}><EditorContent editor={editor} /><TextBubbleMenu editor={editor} /></div></TooltipProvider>;
}
createRoot(window.document.getElementById("root")!).render(<TablesEditor />);
