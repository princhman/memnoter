import { action } from "@/lib/shortcuts";
import { Node, PasteRule, type Editor } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import katex from "katex";
import { createMathIndex } from "./math-index";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inlineMath: {
      insertInlineMath: (tex?: string) => ReturnType;
      toggleInlineMath: () => ReturnType;
    };
  }
}

export function cleanMathText(tex: string) {
  return tex.replace(/\u200b/g, "");
}

export function renderKatex(el: HTMLElement, tex: string, displayMode = false) {
  try {
    katex.render(tex, el, { throwOnError: false, displayMode });
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

type InlineMathOptions = {
  renderPreviewActions?: (element: HTMLElement, editor: Editor) => () => void;
};
export const InlineMath = Node.create<InlineMathOptions>({
  addOptions() { return {}; },
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
          const { from, to, $from } = state.selection;
          if ($from.parent.type.spec.code) return false;
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
      toggleInlineMath:
        () =>
        ({ state, tr, dispatch, commands }) => {
          const { from, to } = state.selection;
          const found: { pos: number; node: PMNode }[] = [];
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === this.type) found.push({ pos, node });
          });
          if (!found.length) return commands.insertInlineMath();

          for (const { pos, node } of found.reverse()) {
            const text = cleanMathText(node.textContent);
            const end = pos + node.nodeSize;
            if (text) tr.replaceWith(pos, end, state.schema.text(text));
            else tr.delete(pos, end);
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  // Pasted  $...$  converts like the typed form; $$ is left alone.
  addPasteRules() {
    const type = this.type;
    return [
      new PasteRule({
        find: /(?<![$\\])\$([^$\n]+)\$(?!\$)/g,
        handler: ({ state, range, match }) => {
          const tex = match[1];
          // Paste rules visit both a textblock and its text nodes, so skip a
          // range that an earlier match already replaced.
          if (
            !tex.trim() ||
            state.doc.resolve(range.from).parent.type === type ||
            state.doc.textBetween(range.from, range.to) !== match[0]
          ) return;
          state.tr.replaceWith(
            range.from, range.to, type.create(null, state.schema.text(tex)),
          );
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const name = this.name;

    const horizontal = (direction: -1 | 1, extend = false) => {
      const { state, view } = this.editor;
      const { selection } = state;
      const { $head } = selection;

      function stepMath(math: PMNode, pos: number, offset: number): number {
        const text = math.textContent;
        const remaining = direction < 0 ? text.slice(0, offset) : text.slice(offset);
        // From an inner edge, the next stop is just outside the formula.
        if (!cleanMathText(remaining)) return direction < 0 ? pos : pos + math.nodeSize;
        // Cross one visible character, skipping placeholders in older notes.
        while ((direction < 0 && offset > 0) || (direction > 0 && offset < text.length)) {
          const character = direction < 0
            ? Array.from(text.slice(0, offset)).pop()!
            : String.fromCodePoint(text.codePointAt(offset)!);
          offset += direction * character.length;
          if (character !== "\u200b") break;
        }
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
        // Step onto the formula's near inner edge, even when it is empty.
        target = $head.pos + direction;
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
      [action("math.inline").keys]: () => this.editor.commands.toggleInlineMath(),

      ArrowRight: () => horizontal(1),
      ArrowLeft: () => horizontal(-1),
      "Shift-ArrowRight": () => horizontal(1, true),
      "Shift-ArrowLeft": () => horizontal(-1, true),
      ArrowUp: () => vertical(-1),
      ArrowDown: () => vertical(1),
      "Shift-ArrowUp": () => vertical(-1, true),
      "Shift-ArrowDown": () => vertical(1, true),

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
          if (!cleanMathText($from.parent.textContent)) {
            const from = $from.before();
            return editor
              .chain()
              .deleteRange({ from, to: from + $from.parent.nodeSize })
              .run();
          }
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

        if ($from.nodeAfter?.type.name === name) {
          return editor.commands.setTextSelection($from.pos + 1);
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const name = this.name;
    const type = this.type;
    const collect = createMathIndex(name);
    const pluginKey = new PluginKey<{ nodes: ReturnType<typeof collect> }>("inlineMath");
    const editor = this.editor;
    const renderActions = this.options.renderPreviewActions;
    const previewRoots = new WeakMap<globalThis.Node, () => void>();

    const makePreview = (tex: string) => () => {
      const visibleTex = cleanMathText(tex);
      const anchor = document.createElement("span");
      anchor.className = "inline-math-preview";
      anchor.contentEditable = "false";
      const box = document.createElement("span");
      const formula = document.createElement("span");
      if (visibleTex.trim()) renderKatex(formula, visibleTex);
      const actions = document.createElement("span");
      actions.className = "inline-math-preview-actions";
      box.append(formula, actions);
      anchor.appendChild(box);

      const dispose = renderActions?.(actions, editor);
      if (dispose) previewRoots.set(anchor, dispose);
      return anchor;
    };
    const previewSpec = {
      side: -1,
      // ProseMirror must not treat clicks on the buttons as editor input.
      stopEvent: () => true,
      ignoreSelection: true,
      destroy: (dom: globalThis.Node) => {
        const root = previewRoots.get(dom);
        // Unmounting during ProseMirror's own update upsets React.
        if (root) queueMicrotask(root);
      },
    };

    return [
      new Plugin({
        key: pluginKey,

        // Rescan only the changed range and shift unaffected formula positions.
        state: {
          init: (_, state) => ({ nodes: collect(state.doc) }),
          apply: (tr, value) =>
            tr.docChanged ? { nodes: collect(tr.doc) } : value,
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
                      ...previewSpec,
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
                  // side 1 keeps a caret before the formula in front of this
                  // anchor. Between them, WebKit draws it after an empty one.
                  Decoration.widget(pos, anchor, { side: 1, key: "math-before" }),
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
