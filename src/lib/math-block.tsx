import { Node, selectionToInsertionEnd } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { renderKatex } from "./inline-math";
import { createViewportRenderer } from "./viewport-renderer";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mathBlock: {
      // Turns the current line, selection or inline formula into a block, or
      // a block back into a paragraph.
      toggleMathBlock: () => ReturnType;
    };
  }
}

/**
 * Display math written as  $$ ... $$.
 *
 * Like inline math, the node stores its LaTeX as real text. With the cursor
 * outside it shows only the rendered formula; with the cursor inside it shows
 * the source between  $$  markers, with the rendered formula as a live preview
 * underneath.
 */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true, // newlines on Enter, and no input or paste rules inside
  defining: true,
  // Runs its arrow keys before inline math, which would otherwise claim
  // moves between a formula-only paragraph and a block.
  priority: 101,

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]', preserveWhitespace: "full" }];
  },

  renderHTML() {
    return ["div", { "data-type": "math-block", class: "math-block" }, 0];
  },

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

  addCommands() {
    return {
      toggleMathBlock:
        () =>
        ({ state, tr, dispatch }) => {
          const { selection, schema } = state;
          const { $from, $to } = selection;
          const parent = $from.parent;
          const start = $from.depth > 0 ? $from.before() : 0;
          const end = start + parent.nodeSize;

          if (parent.type === this.type) {
            // A paragraph holds one line, so the source's lines are joined.
            const text = parent.textContent.replace(/\s*\n\s*/g, " ").trim();
            const paragraph = schema.nodes.paragraph.create(
              null,
              text ? schema.text(text) : null,
            );
            tr.replaceWith(start, end, paragraph);
            tr.setSelection(TextSelection.create(tr.doc, start + 1 + text.length));
          } else if (parent.type.name === "inlineMath") {
            const text = parent.textContent.replace(/​/g, "");
            const steps = tr.steps.length;
            tr.replaceRangeWith(start, end, this.type.create(null, text ? schema.text(text) : null));
            selectionToInsertionEnd(tr, steps, -1);
          } else if (parent.isTextblock && !parent.type.spec.code) {
            if (!$from.sameParent($to)) return false;
            const steps = tr.steps.length;
            // Hard breaks end lines in the source; dropping them would let a
            // `%` comment swallow the next line.
            const leafText = (node: PMNode) => (node.type.name === "hardBreak" ? "\n" : "");
            if (selection.empty) {
              const index = $from.index(-1);
              if (!$from.node(-1).canReplaceWith(index, index + 1, this.type)) return false;
              const text = parent.textBetween(0, parent.content.size, undefined, leafText);
              tr.replaceWith(start, end, this.type.create(null, text ? schema.text(text) : null));
            } else {
              const text = state.doc.textBetween(selection.from, selection.to, undefined, leafText);
              tr.replaceRangeWith(
                selection.from,
                selection.to,
                this.type.create(null, text ? schema.text(text) : null),
              );
            }
            selectionToInsertionEnd(tr, steps, -1);
          } else {
            return false;
          }
          if (dispatch) dispatch(tr.scrollIntoView());
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    const type = this.type;

    const select = (anchor: number, head = anchor) => {
      const { view } = this.editor;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, anchor, head))
          .scrollIntoView(),
      );
      return true;
    };

    // Rendered blocks hide their source, so native caret movement would skip
    // them. Step onto the near edge of the source instead.
    const enter = (direction: -1 | 1, unit: "line" | "character", extend = false) => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!extend && !selection.empty) return false;
      const { $head } = selection;
      if (!$head.parent.isTextblock || $head.depth < 1) return false;
      const edge =
        unit === "line"
          ? direction < 0 ? "up" : "down"
          : direction < 0 ? "left" : "right";
      if (!view.endOfTextblock(edge)) return false;
      const boundary = direction < 0 ? $head.before() : $head.after();
      const next = Selection.findFrom(state.doc.resolve(boundary), direction);
      if (!next || next.$head.parent.type !== type) return false;
      return select(extend ? selection.anchor : next.head, next.head);
    };

    // The previous or next sibling when the caret is at that edge of a block.
    const neighbour = ($pos: ResolvedPos, direction: -1 | 1): PMNode | null => {
      if ($pos.depth < 1) return null;
      const atEdge =
        direction < 0
          ? $pos.parentOffset === 0
          : $pos.parentOffset === $pos.parent.content.size;
      if (!atEdge) return null;
      const $boundary = this.editor.state.doc.resolve(
        direction < 0 ? $pos.before() : $pos.after(),
      );
      return direction < 0 ? $boundary.nodeBefore : $boundary.nodeAfter;
    };

    // Backspace / Delete at the edge facing a block start editing it rather
    // than merging text into it; an empty line in between is removed.
    const deleteToward = (direction: -1 | 1) => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!selection.empty) return false;
      const { $from } = selection;

      if ($from.parent.type === type) {
        const atEdge =
          direction < 0
            ? $from.parentOffset === 0
            : $from.parentOffset === $from.parent.content.size;
        if (!atEdge) return false;
        // An empty block turns back into a paragraph.
        if ($from.parent.content.size === 0) {
          return this.editor.commands.setNode("paragraph");
        }
        const beyond = Selection.findFrom(
          state.doc.resolve(direction < 0 ? $from.before() : $from.after()),
          direction,
          true,
        );
        return beyond ? select(beyond.head) : true;
      }

      const block = neighbour($from, direction);
      if (block?.type !== type) return false;
      if ($from.parent.content.size === 0) {
        const start = $from.before();
        const tr = state.tr.delete(start, start + $from.parent.nodeSize);
        const inside = direction < 0 ? start - 1 : start + 1;
        tr.setSelection(TextSelection.create(tr.doc, inside));
        view.dispatch(tr.scrollIntoView());
        return true;
      }
      const boundary = direction < 0 ? $from.before() : $from.after();
      return select(direction < 0 ? boundary - 1 : boundary + 1);
    };

    return {
      "Mod-Alt-m": () => this.editor.commands.toggleMathBlock(),

      ArrowUp: () => enter(-1, "line"),
      ArrowDown: () => enter(1, "line"),
      ArrowLeft: () => enter(-1, "character"),
      ArrowRight: () => enter(1, "character"),
      "Shift-ArrowUp": () => enter(-1, "line", true),
      "Shift-ArrowDown": () => enter(1, "line", true),
      "Shift-ArrowLeft": () => enter(-1, "character", true),
      "Shift-ArrowRight": () => enter(1, "character", true),

      // Leave the block for the line below, adding one if needed. Mod-Enter
      // (exitCode) always opens a new line instead.
      Escape: ({ editor }) => {
        const { $head } = editor.state.selection;
        if ($head.parent.type !== type) return false;
        const after = $head.after();
        const next = editor.state.doc.resolve(after).nodeAfter;
        if (next?.isTextblock && !next.type.spec.code) return select(after + 1);
        return editor.commands.exitCode();
      },

      Backspace: () => deleteToward(-1),
      Delete: () => deleteToward(1),
    };
  },

  addProseMirrorPlugins() {
    const type = this.type;

    return [
      new Plugin({
        key: new PluginKey("mathBlock"),
        props: {
          // Typing  $$  on an empty line starts a block.
          handleTextInput(view, from, to, text) {
            if (text !== "$" || from !== to) return false;
            const { state } = view;
            const $pos = state.doc.resolve(from);
            const parent = $pos.parent;
            if (
              parent.type.name !== "paragraph" ||
              parent.textContent !== "$" ||
              $pos.parentOffset !== 1
            ) return false;
            const index = $pos.index(-1);
            if (!$pos.node(-1).canReplaceWith(index, index + 1, type)) return false;
            const start = $pos.before();
            const tr = state.tr.replaceWith(start, start + parent.nodeSize, type.create());
            tr.setSelection(TextSelection.create(tr.doc, start + 1));
            view.dispatch(tr.scrollIntoView());
            return true;
          },

          // Pasting a whole  $$ ... $$  as plain text makes a block.
          handlePaste(view, event) {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const match = /^\s*\$\$((?:(?!\$\$)[\s\S])*)\$\$\s*$/.exec(text);
            const tex = match?.[1].trim();
            if (!tex || view.state.selection.$from.parent.type.spec.code) return false;
            const node = type.create(null, view.state.schema.text(tex));
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            return true;
          },

          // Show the source of any block either end of the selection is in.
          decorations(state) {
            const { $from, $to } = state.selection;
            const decorations: Decoration[] = [];
            let previous = -1;
            for (const $pos of [$from, $to]) {
              if ($pos.parent.type !== type) continue;
              const pos = $pos.before();
              if (pos === previous) continue;
              previous = pos;
              decorations.push(
                Decoration.node(
                  pos, pos + $pos.parent.nodeSize, { class: "is-editing" }, { mathEditing: true },
                ),
              );
            }
            return decorations.length
              ? DecorationSet.create(state.doc, decorations)
              : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export default MathBlock;
