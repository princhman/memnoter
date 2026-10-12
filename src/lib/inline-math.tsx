// ai - generated module
import { Node } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import katex from "katex";
import "katex/dist/katex.min.css";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inlineMath: {
      // use current selection
      insertInlineMath: (tex?: string) => ReturnType;
    };
  }
}

type MathInfo = { pos: number; size: number; tex: string };
const EMPTY_MATH_PLACEHOLDER = "\u200b";

function cleanMathText(tex: string) {
  return tex.replace(/\u200b/g, "");
}

function collect(doc: PMNode, name: string): MathInfo[] {
  const out: MathInfo[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) {
      out.push({ pos, size: node.nodeSize, tex: node.textContent });
      return false;
    }
    return true;
  });
  return out;
}

function renderKatex(el: HTMLElement, tex: string) {
  try {
    katex.render(tex, el, { throwOnError: false, displayMode: false });
  } catch {
    el.textContent = tex;
  }
}

/**
 * Obsidian-style inline math.
 *
 * The node stores its LaTeX as real text (`content: 'text*'`).
 *   - Cursor OUTSIDE: the node is hidden (display:none) and a sibling widget
 *     decoration right after it shows the rendered KaTeX.
 *   - Cursor INSIDE:  the node is shown as raw source  $...$  and a floating
 *     live preview is shown above it.
 *
 * Keeping the rendered KaTeX *outside* the node (as a widget) is what makes
 * the caret display correctly before/after the formula.
 */

export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  content: "text*",
  marks: "",
  code: true, // also stops other input rules (bold, etc.) from firing inside
  selectable: false,
  atom: false,

  parseHTML() {
    return [
      { tag: 'span[data-type="inline-math"]', preserveWhitespace: "full" },
    ];
  },

  renderHTML() {
    return ["span", { "data-type": "inline-math", class: "inline-math" }, 0];
  },

  addCommands() {
    return {
      insertInlineMath:
        (tex) =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection;
          const text = tex ?? state.doc.textBetween(from, to, " ");
          const content = text || EMPTY_MATH_PLACEHOLDER;
          const node = this.type.create(null, state.schema.text(content));

          tr.replaceRangeWith(from, to, node);
          const insertPos = tr.mapping.map(from, -1);
          tr.setSelection(
            TextSelection.create(tr.doc, insertPos + 1 + content.length),
          );
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  // cursor / key handling
  addKeyboardShortcuts() {
    const name = this.name;

    return {
      "Mod-Shift-m": ({ editor }) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name === name) {
          const from = $from.before();
          const to = from + $from.parent.nodeSize;
          const text = cleanMathText($from.parent.textContent);

          if (!text) return editor.chain().deleteRange({ from, to }).run();

          return editor
            .chain()
            .insertContentAt({ from, to }, { type: "text", text })
            .setTextSelection(from + text.length)
            .run();
        }
        return editor.commands.insertInlineMath();
      },

      // enter the math node from the left, or leave it at the right edge
      ArrowRight: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;

        if ($from.parent.type.name === name) {
          if ($from.parentOffset === $from.parent.content.size) {
            return editor.commands.setTextSelection($from.after());
          }
          return false;
        }
        if ($from.nodeAfter?.type.name === name) {
          return editor.commands.setTextSelection($from.pos + 1);
        }
        return false;
      },

      // enter the math node from the right, or leave it at the left edge
      ArrowLeft: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;

        if ($from.parent.type.name === name) {
          if ($from.parentOffset === 0) {
            return editor.commands.setTextSelection($from.before());
          }
          return false;
        }
        if ($from.nodeBefore?.type.name === name) {
          return editor.commands.setTextSelection($from.pos - 1);
        }
        return false;
      },

      // enter inside math = finish editing
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        const { $from } = selection;
        if (!selection.empty || $from.parent.type.name !== name) return false;
        return editor.commands.setTextSelection($from.after());
      },

      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;

        if ($from.parent.type.name === name) {
          // empty node -> remove it
          if (!cleanMathText($from.parent.textContent)) {
            const from = $from.before();
            return editor
              .chain()
              .deleteRange({ from, to: from + $from.parent.nodeSize })
              .run();
          }
          // at start -> step out to the left
          if ($from.parentOffset === 0) {
            return editor.commands.setTextSelection($from.before());
          }
          return false;
        }

        // Right after a rendered formula -> start editing it (caret at end)
        if ($from.nodeBefore?.type.name === name) {
          return editor.commands.setTextSelection($from.pos - 1);
        }
        return false;
      },

      Delete: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;

        if ($from.parent.type.name === name) {
          if (!cleanMathText($from.parent.textContent)) {
            const from = $from.before();
            return editor
              .chain()
              .deleteRange({ from, to: from + $from.parent.nodeSize })
              .run();
          }
          if ($from.parentOffset === $from.parent.content.size) {
            return editor.commands.setTextSelection($from.after());
          }
          return false;
        }

        // Right before a rendered formula -> start editing it (caret at start)
        if ($from.nodeAfter?.type.name === name) {
          return editor.commands.setTextSelection($from.pos + 1);
        }
        return false;
      },
    };
  },

  // Plugins
  addProseMirrorPlugins() {
    const name = this.name;
    const type = this.type;
    const pluginKey = new PluginKey<{ nodes: MathInfo[] }>("inlineMath");

    // rendered formula, shown right AFTER the (hidden) node
    const makeRendered = (tex: string, selected: boolean, size: number) => {
      const visibleTex = cleanMathText(tex);
      return (view: EditorView, getPos: () => number | undefined) => {
        const el = document.createElement("span");
        el.className = "inline-math-widget";
        el.contentEditable = "false";
        el.classList.toggle("is-selected", selected);
        el.classList.toggle("is-empty", !visibleTex.trim());
        if (visibleTex.trim()) renderKatex(el, visibleTex);

        // Click -> put the caret inside, on the side that was clicked
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const end = getPos();
          if (typeof end !== "number") return;
          const rect = el.getBoundingClientRect();
          const leftHalf = e.clientX < rect.left + rect.width / 2;
          const target = leftHalf ? end - size + 1 : end - 1;
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, target),
            ),
          );
          view.focus();
        });
        return el;
      };
    };

    // floating preview, shown above the node while it is being edited
    const makePreview = (tex: string) => () => {
      const visibleTex = cleanMathText(tex);
      const anchor = document.createElement("span");
      anchor.className = "inline-math-preview";
      anchor.contentEditable = "false";
      const box = document.createElement("span");
      if (visibleTex.trim()) renderKatex(box, visibleTex);
      anchor.appendChild(box);
      return anchor;
    };

    return [
      new Plugin({
        key: pluginKey,

        // cache the list of math nodes; rescan only when the doc changes
        state: {
          init: (_, state) => ({ nodes: collect(state.doc, name) }),
          apply: (tr, value) =>
            tr.docChanged ? { nodes: collect(tr.doc, name) } : value,
        },

        props: {
          // Typing the closing `$` of  $...$  converts the text into a math node
          handleTextInput(view, from, to, text) {
            if (text !== "$" || from !== to) return false;

            const { state } = view;
            const $pos = state.doc.resolve(from);
            const parent = $pos.parent;
            if (!parent.inlineContent || parent.type.spec.code) return false;

            // Text before the caret; non-text inline nodes keep their length
            // so string offsets line up with document positions.
            let before = "";
            parent.forEach((child, offset) => {
              if (offset >= $pos.parentOffset) return;
              before += child.isText
                ? child.text!.slice(0, $pos.parentOffset - offset)
                : "\ufffc".repeat(child.nodeSize);
            });

            const match = /(^|[^$\\])\$([^$\n]+)$/.exec(before);
            if (!match) return false;

            const tex = match[2];
            if (!tex.trim() || tex.includes("\ufffc")) return false;

            const start = from - tex.length - 1;
            const node = type.create(null, state.schema.text(tex));
            const tr = state.tr.replaceWith(start, from, node);
            tr.setSelection(
              TextSelection.create(tr.doc, start + node.nodeSize),
            );
            view.dispatch(tr.scrollIntoView());
            return true;
          },

          decorations(state) {
            const pluginState = pluginKey.getState(state);
            if (!pluginState || !pluginState.nodes.length)
              return DecorationSet.empty;

            const { from, to, empty } = state.selection;
            const decos: Decoration[] = [];

            for (const { pos, size, tex } of pluginState.nodes) {
              const end = pos + size;
              const editing = from > pos && to < end; // selection strictly inside

              if (editing) {
                decos.push(Decoration.node(pos, end, { class: "is-editing" }));
                if (cleanMathText(tex).trim()) {
                  decos.push(
                    Decoration.widget(pos, makePreview(tex), {
                      side: -1,
                      key: `p:${tex}`,
                    }),
                  );
                }
              } else {
                const selected = !empty && from <= pos && to >= end;
                // Hide the raw source. Done inline so it can't be undone by stale/overridden CSS.
                decos.push(
                  Decoration.node(pos, end, {
                    class: "inline-math-hidden",
                    style: "display: none",
                  }),
                );
                decos.push(
                  Decoration.widget(end, makeRendered(tex, selected, size), {
                    side: -1, // before the caret at `end`, so the caret sits AFTER the formula
                    key: `r:${tex}:${selected}`,
                    stopEvent: () => true,
                  }),
                );
              }
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export default InlineMath;
