import { MathBlock } from "../math-block";
import { createViewportRenderer } from "../viewport-renderer";
import { renderKatex } from "../inline-math";
import { TextSelection } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
export const MathBlockView = MathBlock.extend({
  addNodeView() {
    const deferRender = createViewportRenderer();
    return ({ node, decorations, getPos, editor }) => {
      const dom = document.createElement("div");
      dom.className = "math-block";
      dom.dataset.type = "math-block";
      const contentDOM = document.createElement("div");
      contentDOM.className = "math-block-source";
      contentDOM.spellcheck = false;
      const rendered = document.createElement("div");
      rendered.className = "math-block-widget";
      rendered.contentEditable = "false";
      // Real elements rather than CSS generated content: WebKit draws the
      // caret on the wrong line next to block pseudo-elements in the source.
      const marker = () => {
        const element = document.createElement("div");
        element.className = "math-block-marker";
        element.contentEditable = "false";
        element.textContent = "$$";
        return element;
      };
      dom.append(marker(), contentDOM, marker(), rendered);

      let currentNode = node;
      let renderedTex: string | undefined;
      let cancelRender: (() => void) | undefined;
      let wasEditing: boolean | undefined;
      const renderNow = () => {
        cancelRender?.();
        cancelRender = undefined;
        const tex = currentNode.textContent;
        if (tex.trim()) renderKatex(rendered, tex, true);
        else rendered.replaceChildren();
        renderedTex = tex;
      };
      const updateAppearance = (nextDecorations: readonly Decoration[]) => {
        const editing = nextDecorations.some(
          (decoration) => decoration.spec.mathEditing,
        );
        if (editing !== wasEditing) {
          contentDOM.style.display = editing ? "" : "none";
          // The hidden source must not take the caret while rendered.
          dom.contentEditable = editing ? "true" : "false";
          wasEditing = editing;
        }
        const tex = currentNode.textContent;
        rendered.classList.toggle("is-empty", !tex.trim());
        if (tex === renderedTex) return;
        // While editing, the rendered formula doubles as a live preview.
        if (editing || !tex.trim()) {
          renderNow();
        } else {
          cancelRender?.();
          rendered.textContent = tex;
          renderedTex = undefined;
          cancelRender = deferRender(rendered, renderNow);
        }
      };

      rendered.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pos = getPos();
        if (typeof pos !== "number") return;
        const { view } = editor;
        // Clicking the preview while editing keeps the caret where it is.
        if (wasEditing) return view.focus();
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, pos + 1 + currentNode.content.size),
          ),
        );
        view.focus();
      });

      updateAppearance(decorations);
      return {
        dom,
        contentDOM,
        destroy() {
          cancelRender?.();
        },
        update(nextNode, nextDecorations) {
          if (nextNode.type !== currentNode.type) return false;
          currentNode = nextNode;
          updateAppearance(nextDecorations);
          return true;
        },
        stopEvent: (event) =>
          event.target instanceof window.Node && rendered.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" &&
          (rendered.contains(mutation.target) ||
            (mutation.type === "attributes" && mutation.target === contentDOM)),
      };
    };
  },

});
