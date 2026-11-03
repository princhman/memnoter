import { Extension } from "@tiptap/core";
import { AllSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const selectionKey = new PluginKey<{ composing: boolean }>("textSelectionHighlight");

// Native WebKit selection paints selected newlines all the way to the block
// edge. These inline boxes stop at text, leaving breaks and block gaps clear.
export const TextSelectionHighlight = Extension.create({
  name: "textSelectionHighlight",
  addProseMirrorPlugins() {
    let currentView: EditorView | undefined;
    return [new Plugin({
      key: selectionKey,
      view(view) {
        currentView = view;
        return { destroy() { currentView = undefined; } };
      },
      props: {
        decorations(state) {
          if (currentView?.composing || selectionKey.getState(state)?.composing) return DecorationSet.empty;
          const { selection, doc } = state;
          if (selection.empty || !(selection instanceof TextSelection || selection instanceof AllSelection)) return DecorationSet.empty;
          const { from, to } = selection;
          const decorations: Decoration[] = [];
          doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === "mathBlock" && from <= pos && to >= pos + node.nodeSize) {
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-range-selected" }));
            }
            if (!node.isTextblock && node.type.name !== "inlineMath") return;
            let runStart: number | undefined;
            let runEnd = 0;
            const flush = () => {
              if (runStart !== undefined) decorations.push(Decoration.inline(runStart, runEnd, { class: "text-range-selected" }));
              runStart = undefined;
            };
            // Usually one box per textblock. Break the run at hard breaks and
            // nontext nodes so no background fills an image or math preview.
            node.forEach((child, offset) => {
              const start = Math.max(from, pos + 1 + offset);
              const end = Math.min(to, pos + 1 + offset + child.nodeSize);
              if (!child.isText || start >= end) return flush();
              runStart ??= start;
              runEnd = end;
            });
            flush();
            // Descend into inline math to decorate its editable source too.
          });
          return DecorationSet.create(doc, decorations);
        },
        handleDOMEvents: {
          compositionstart(view) {
            view.dispatch(view.state.tr.setMeta(selectionKey, { composing: true }));
            return false;
          },
          compositionend(view) {
            // ProseMirror finishes the composition before the next task.
            setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(selectionKey, { composing: false })); }, 0);
            return false;
          },
        },
      },
      state: {
        init: () => ({ composing: false }),
        apply(tr, previous) { return tr.getMeta(selectionKey) ?? previous; },
      },
    })];
  },
});
