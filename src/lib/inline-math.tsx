// ai - generated module
import { Node } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
 *   - Cursor OUTSIDE: the source is hidden inside a visible node view that
 *     shows the rendered KaTeX.
 *   - Cursor INSIDE:  the node is shown as raw source  $...$  and a floating
 *     live preview is shown above it.
 *
 * Keeping the node's outer element visible gives the browser real boundaries
 * for the caret before and after the formula.
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

  addNodeView() {
    return ({ node, decorations, getPos, editor }) => {
      const dom = document.createElement("span");
      dom.className = "inline-math";
      dom.dataset.type = "inline-math";
      const contentDOM = document.createElement("span");
      contentDOM.className = "inline-math-source";
      const rendered = document.createElement("span");
      rendered.className = "inline-math-widget";
      rendered.contentEditable = "false";
      dom.append(contentDOM, rendered);

      let currentNode = node;
      const updateAppearance = (nextDecorations: readonly Decoration[]) => {
        const editing = nextDecorations.some(
          (decoration) => decoration.spec.mathEditing,
        );
        const selected = nextDecorations.some(
          (decoration) => decoration.spec.mathSelected,
        );
        contentDOM.style.display = editing ? "" : "none";
        rendered.style.display = editing ? "none" : "inline-block";
        // A rendered formula must not expose its hidden source to native caret movement.
        dom.contentEditable = editing ? "true" : "false";
        const tex = cleanMathText(currentNode.textContent);
        rendered.classList.toggle("is-empty", !tex.trim());
        rendered.classList.toggle("is-selected", selected);
        if (tex.trim()) renderKatex(rendered, tex);
        else rendered.replaceChildren();
      };

      rendered.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const pos = getPos();
        if (typeof pos !== "number") return;
        const rect = rendered.getBoundingClientRect();
        const edge = Math.min(6, rect.width / 4);
        // Rendered math and LaTeX have different widths. Map the click's
        // relative position to a source character boundary before revealing it.
        const fraction = Math.max(0, Math.min(1,
          (event.clientX - rect.left) / (rect.width || 1),
        ));
        const characters = Array.from(currentNode.textContent);
        const offset = characters
          .slice(0, Math.round(fraction * characters.length))
          .join("").length;
        // The outer edges place the caret in surrounding text; the middle edits.
        const target =
          event.clientX <= rect.left + edge
            ? pos
            : event.clientX >= rect.right - edge
              ? pos + currentNode.nodeSize
              : pos + 1 + offset;
        const { view } = editor;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, target)),
        );
        view.focus();
      });

      updateAppearance(decorations);
      return {
        dom,
        contentDOM,
        update(nextNode, nextDecorations) {
          if (nextNode.type !== currentNode.type) return false;
          currentNode = nextNode;
          updateAppearance(nextDecorations);
          return true;
        },
        setSelection(anchor, head) {
          const pos = getPos();
          if (typeof pos !== "number") return;
          const selection = dom.ownerDocument.getSelection();
          if (!selection) return;
          const from = editor.view.domAtPos(pos + 1 + anchor);
          const to = editor.view.domAtPos(pos + 1 + head);
          // WebKit can consider the outer boundary equivalent to offset zero
          // inside the source. Explicitly enter the editable text in both cases.
          selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
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
      insertInlineMath:
        (tex) =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection;
          const text = tex ?? state.doc.textBetween(from, to, " ");
          const node = this.type.create(null, text ? state.schema.text(text) : null);

          tr.replaceRangeWith(from, to, node);
          const insertPos = tr.mapping.map(from, -1);
          tr.setSelection(
            TextSelection.create(tr.doc, insertPos + 1 + text.length),
          );
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  // cursor / key handling
  addKeyboardShortcuts() {
    const name = this.name;

    const horizontal = (direction: -1 | 1, extend = false) => {
      const { state, view } = this.editor;
      const { selection } = state;
      const { $head } = selection;

      function stepOutside(pos: number): number {
        const $pos = state.doc.resolve(pos);
        const adjacent = direction < 0 ? $pos.nodeBefore : $pos.nodeAfter;
        if (adjacent?.type.name === name) {
          const start = direction < 0 ? pos - adjacent.nodeSize : pos;
          return stepMath(adjacent, start, direction < 0 ? adjacent.content.size : 0);
        }
        if (adjacent?.isText) {
          const character = direction < 0
            ? Array.from(adjacent.text!).pop()!
            : String.fromCodePoint(adjacent.text!.codePointAt(0)!);
          return pos + direction * character.length;
        }
        const nextPos = pos + direction * (adjacent?.nodeSize ?? 1);
        if (nextPos < 0 || nextPos > state.doc.content.size) return pos;
        return Selection.findFrom(state.doc.resolve(nextPos), direction, true)?.head ?? pos;
      }

      function stepMath(math: PMNode, pos: number, offset: number): number {
        const text = math.textContent;
        if (!cleanMathText(text)) return direction < 0 ? pos : pos + math.nodeSize;
        const remaining = direction < 0 ? text.slice(0, offset) : text.slice(offset);
        if (!cleanMathText(remaining)) {
          // A typed or clicked inner endpoint shares its visible position with
          // the outer boundary. Move past that shared stop in the same press.
          return stepOutside(direction < 0 ? pos : pos + math.nodeSize);
        }
        // Cross one visible character, skipping placeholders in older notes.
        while ((direction < 0 && offset > 0) || (direction > 0 && offset < text.length)) {
          const character = direction < 0
            ? Array.from(text.slice(0, offset)).pop()!
            : String.fromCodePoint(text.codePointAt(offset)!);
          offset += direction * character.length;
          if (character !== "\u200b") break;
        }
        if (direction < 0 && !cleanMathText(text.slice(0, offset))) return pos;
        if (direction > 0 && !cleanMathText(text.slice(offset))) return pos + math.nodeSize;
        return pos + 1 + offset;
      }

      let target: number;
      if (!extend && !selection.empty) {
        if (
          $head.parent.type.name !== name &&
          selection.$anchor.parent.type.name !== name
        ) return false;
        target = direction < 0 ? selection.from : selection.to;
      } else if ($head.parent.type.name === name) {
        target = stepMath($head.parent, $head.before(), $head.parentOffset);
      } else {
        const adjacent = direction < 0 ? $head.nodeBefore : $head.nodeAfter;
        if (adjacent?.type.name !== name) return false;
        target = stepOutside($head.pos);
      }
      view.dispatch(
        state.tr.setSelection(TextSelection.create(
          state.doc, extend ? selection.anchor : target, target,
        )).scrollIntoView(),
      );
      return true;
    };

    const vertical = (direction: -1 | 1, extend = false) => {
      const { state, view } = this.editor;
      const { selection } = state;
      if (!extend && !selection.empty) return false;
      const { $head } = selection;
      const insideMath = $head.parent.type.name === name;
      // Only take over block transitions involving math. Native movement still
      // owns wrapped text lines and all ordinary paragraphs.
      if (!view.endOfTextblock(direction < 0 ? "up" : "down")) return false;
      const depth = insideMath ? $head.depth - 1 : $head.depth;
      if (depth < 1) return false;
      const boundary = direction < 0 ? $head.before(depth) : $head.after(depth);
      const next = Selection.findFrom(state.doc.resolve(boundary), direction, true);
      if (!next) return insideMath;
      const block = next.$head.parent;
      const mathOnly =
        block.type.name === name ||
        (block.childCount === 1 && block.firstChild?.type.name === name);
      const currentBlock = $head.node(depth);
      const currentMathOnly =
        currentBlock.childCount === 1 && currentBlock.firstChild?.type.name === name;
      if (!insideMath && !mathOnly && !currentMathOnly) return false;

      const caret = view.coordsAtPos($head.pos);
      let target = next.head;
      if (mathOnly) {
        const pos =
          block.type.name === name ? next.$head.before() : next.$head.start();
        const math = block.type.name === name ? block : block.firstChild!;
        const dom = view.nodeDOM(pos);
        if (!(dom instanceof HTMLElement)) return false;
        const rect = dom.getBoundingClientRect();
        target =
          caret.left <= rect.left + rect.width / 2 ? pos : pos + math.nodeSize;
      } else {
        const coords = view.coordsAtPos(next.head);
        const hit = view.posAtCoords({
          left: caret.left, top: (coords.top + coords.bottom) / 2,
        });
        if (hit && state.doc.resolve(hit.pos).sameParent(next.$head)) {
          target = hit.pos;
        }
      }
      view.dispatch(
        state.tr.setSelection(TextSelection.create(
          state.doc, extend ? selection.anchor : target, target,
        )).scrollIntoView(),
      );
      return true;
    };

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

      ArrowRight: () => horizontal(1),
      ArrowLeft: () => horizontal(-1),
      "Shift-ArrowRight": () => horizontal(1, true),
      "Shift-ArrowLeft": () => horizontal(-1, true),
      ArrowUp: () => vertical(-1),
      ArrowDown: () => vertical(1),
      "Shift-ArrowUp": () => vertical(-1, true),
      "Shift-ArrowDown": () => vertical(1, true),

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
          handleDOMEvents: {
            mousedown(view, event) {
              if (event.button !== 0 || event.shiftKey) return false;
              const { $head } = view.state.selection;
              if ($head.parent.type.name !== name) return false;
              const pos = $head.before();
              const end = pos + $head.parent.nodeSize;
              const dom = view.nodeDOM(pos);
              if (!(dom instanceof HTMLElement)) return false;
              const source = dom.querySelector<HTMLElement>(".inline-math-source");
              if (!source) return false;
              const rect = source.getBoundingClientRect();
              if (event.clientY < rect.top || event.clientY > rect.bottom) return false;
              if (event.clientX > rect.left && event.clientX < rect.right) return false;

              // Dollar signs, padding, and the empty space beside a formula
              // should leave editing. Preserve clicks on surrounding text.
              const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!hit || hit.pos < pos || hit.pos > end) return false;
              const target = event.clientX <= rect.left ? pos : end;
              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, target)),
              );
              view.focus();
              return true;
            },
          },
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
              // Keep source visible while either end of a text selection is
              // inside it, including Shift-arrow selections across its edge.
              const editing =
                (from > pos && from < end) || (to > pos && to < end);

              if (editing) {
                decos.push(
                  Decoration.node(
                    pos, end, { class: "is-editing" }, { mathEditing: true },
                  ),
                );
                if (cleanMathText(tex).trim()) {
                  decos.push(
                    Decoration.widget(pos, makePreview(tex), {
                      side: -1,
                      key: `p:${tex}`,
                    }),
                  );
                }
              } else {
                // Give a formula-only paragraph real line-height caret stops on
                // both sides without adding characters to the saved document.
                const anchor = () => {
                  const span = document.createElement("span");
                  span.textContent = "\u200b";
                  span.setAttribute("aria-hidden", "true");
                  return span;
                };
                decos.push(
                  Decoration.widget(pos, anchor, { side: -1, key: "math-before" }),
                  Decoration.widget(end, anchor, { side: 1, key: "math-after" }),
                );
                const selected = !empty && from <= pos && to >= end;
                if (selected) {
                  decos.push(
                    Decoration.node(
                      pos, end, { class: "is-selected" }, { mathSelected: true },
                    ),
                  );
                }
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
