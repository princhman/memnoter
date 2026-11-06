import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { noteExtensions } from "@/lib/note-extensions";
import { extractCards } from "@/lib/cards";
import { extractFromDoc, extractFromYDoc } from "@/lib/search-text";
import { execEditor, editorState } from "@/editor-host/commands";
import { TextBubbleMenu } from "@/components/text-bubble-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/App.css";

const document = new Y.Doc();
function TablesEditor() {
  const editor = useEditor({ extensions: noteExtensions({ document }), onCreate: ({ editor }) => {
    Object.assign(window, {
      editor, documentY: document, extractCards, extractFromDoc, extractFromYDoc, execEditor, editorState,
      stopCapture: () => yUndoPluginKey.getState(editor.state).undoManager.stopCapturing(),
      cloneEditor: (legacy = false) => {
        const clone = new Y.Doc();
        Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
        const extensions = noteExtensions({ document: clone });
        const other = new Editor({ extensions: legacy
          ? extensions.filter(extension => !["table", "tableRow", "tableCell", "tableHeader"].includes(extension.name))
          : extensions });
        return { editor: other, document: clone };
      },
    });
  } });
  return <TooltipProvider><div style={{ width: 420, margin: 40 }}><EditorContent editor={editor} /><TextBubbleMenu editor={editor} /></div></TooltipProvider>;
}
createRoot(window.document.getElementById("root")!).render(<TablesEditor />);
