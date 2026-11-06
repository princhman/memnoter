import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";

// Reproduce opening a synced note with the schema from before highlighting.
export function openWithOldSchema(editor: Editor) {
  const source = new Y.Doc();
  const fragment = source.getXmlFragment("default");
  prosemirrorToYXmlFragment(editor.state.doc, fragment);
  const old = new Editor({ extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: source })] });
  const result = { editorText: old.getText(), storedText: fragment.toString() };
  old.destroy(); source.destroy();
  return result;
}
