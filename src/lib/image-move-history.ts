import { Extension } from "@tiptap/core";
import { Plugin, NodeSelection, Selection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

// ProseMirror's native internal drop deletes and inserts the complete image
// slice in one transaction. Keep that transaction apart from adjacent typing
// in Yjs history; attributes and asset references never pass through HTML.
export const ImageMoveHistory = Extension.create({
  name: "imageMoveHistory",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(_transactions, _old, state) {
        const selection = state.selection;
        // A Yjs relative node selection can resolve to the old image boundary
        // after undoing an inline move. Repair it before the view scrolls.
        if (!(selection instanceof NodeSelection) || state.doc.nodeAt(selection.from) === selection.node) return null;
        return state.tr.setSelection(Selection.near(state.doc.resolve(Math.min(selection.from, state.doc.content.size))));
      },
      props: { handleDOMEvents: {
      dragstart(view, event) {
        if ((event.target as HTMLElement).closest(".note-image-block")) {
          yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
        }
        return false;
      },
      drop(view) {
        if (view.dragging?.slice.content.firstChild?.type.name.match(/^(image|inlineImage)$/)) {
          yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
          queueMicrotask(() => {
            if (!view.isDestroyed) yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
          });
        }
        return false;
      },
    } } })];
  },
});
