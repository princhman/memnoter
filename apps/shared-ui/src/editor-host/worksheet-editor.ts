import type { Editor } from "@tiptap/core";
import { isNativeHost, postNativeEvent } from "@/lib/backend";
import { editorState } from "./commands";
let focused: Editor | null = null;
// Each answer editor's own drawing flow, so the native Insert menu can start one in the focused answer.
const drawers = new WeakMap<Editor, () => void>();
if (typeof window !== "undefined") {
  (window as unknown as { memnoterInsertWorksheetDrawing?: () => boolean }).memnoterInsertWorksheetDrawing = () => {
    const insert = focused && !focused.isDestroyed ? drawers.get(focused) : undefined;
    insert?.();
    return !!insert;
  };
}
export function worksheetEditor() { return focused && !focused.isDestroyed ? focused : null; }
export function registerWorksheetEditor(editor: Editor, moduleId: string, answerId: string, insertDrawing?: () => void) {
  if (!isNativeHost()) return () => {};
  if (insertDrawing) drawers.set(editor, insertDrawing);
  const publish = () => {
    if (focused !== editor || editor.isDestroyed || editor.view.dom.closest<HTMLElement>(".native-questions")?.style.display === "none") return;
    postNativeEvent("worksheetEditorState", { active: true, moduleId, answerId, ...editorState(editor, true) });
  };
  const focus = () => { focused = editor; publish(); };
  editor.on("focus", focus); editor.on("transaction", publish);
  return () => {
    editor.off("focus", focus); editor.off("transaction", publish); drawers.delete(editor);
    if (focused === editor) { focused = null; postNativeEvent("worksheetEditorState", { active: false, moduleId }); }
  };
}
