import * as Y from "yjs";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { Editor } from "@tiptap/core";

import { noteExtensions } from "@/lib/editor-schema";

export function liveState() {
  const editor = (document.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  const doc = ySyncPluginKey.getState(editor.state).doc;
  return { bytes: [...Y.encodeStateAsUpdate(doc)], editable: editor.isEditable };
}

// Unlike useNoteDocument, import/backfill callers can hand the binding a doc
// which was already populated before the editor existed.
export function openPreloaded(bytes: number[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(bytes));
  let rendered = false;
  const editor = new Editor({ element: document.createElement("div"),
    extensions: noteExtensions({ document: doc, onFirstRender: () => { rendered = true; } }),
  });
  try {
    editor.commands.insertContent("blocked");
    return { bytes: [...Y.encodeStateAsUpdate(doc)], editable: editor.isEditable, rendered };
  } finally { editor.destroy(); doc.destroy(); }
}
