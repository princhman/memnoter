import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type NodeViewConstructor } from "@tiptap/pm/view";
import type { Node } from "@tiptap/pm/model";
import { commitViewportLayout } from "../reader-scroll";
import { createViewportRenderer } from "../viewport-renderer";

const isMermaid = (node: Node) =>
  node.type.name === "codeBlock" && node.attrs.language === "mermaid";
let diagramId = 0;

// UI only: StarterKit continues to own the codeBlock schema and commands.
export const MermaidView = Extension.create({
  name: "mermaidView",
  priority: 102,

  addKeyboardShortcuts() {
    const enter = (direction: -1 | 1, edge: "up" | "down" | "left" | "right", extend = false) => {
      const { state, view } = this.editor;
      const { selection } = state;
      const { $head } = selection;
      if ((!extend && !selection.empty) || !$head.parent.isTextblock || !$head.depth) return false;
      if (!view.endOfTextblock(edge)) return false;
      const boundary = direction < 0 ? $head.before() : $head.after();
      const next = Selection.findFrom(state.doc.resolve(boundary), direction);
      if (!next || !isMermaid(next.$head.parent)) return false;
      view.dispatch(state.tr.setSelection(TextSelection.create(
        state.doc, extend ? selection.anchor : next.head, next.head,
      )).scrollIntoView());
      return true;
    };
    return {
      ArrowUp: () => enter(-1, "up"),
      ArrowDown: () => enter(1, "down"),
      ArrowLeft: () => enter(-1, "left"),
      ArrowRight: () => enter(1, "right"),
      "Shift-ArrowUp": () => enter(-1, "up", true),
      "Shift-ArrowDown": () => enter(1, "down", true),
      "Shift-ArrowLeft": () => enter(-1, "left", true),
      "Shift-ArrowRight": () => enter(1, "right", true),
      Escape: () => {
        const { state, view } = this.editor;
        const { $head } = state.selection;
        if (!isMermaid($head.parent)) return false;
        const next = Selection.findFrom(state.doc.resolve($head.after()), 1, true);
        if (!next) return this.editor.commands.exitCode();
        view.dispatch(state.tr.setSelection(next).scrollIntoView());
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("mermaidView"),
      props: {
        nodeViews: mermaidNodeViews(this.editor),
        decorations(state) {
          const positions = new Set<number>();
          const decorations: Decoration[] = [];
          for (const $pos of [state.selection.$from, state.selection.$to]) {
            if (!isMermaid($pos.parent) || positions.has($pos.before())) continue;
            positions.add($pos.before());
            decorations.push(Decoration.node($pos.before(), $pos.after(), {}, { mermaidEditing: true }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});

function mermaidNodeViews(editor: Editor): Record<string, NodeViewConstructor> {
  const defer = createViewportRenderer();
  return {
    codeBlock: (node, _view, getPos, decorations) => {
      const mermaid = isMermaid(node);
      const pre = document.createElement("pre");
      const contentDOM = document.createElement("code");
      if (node.attrs.language) contentDOM.className = `language-${node.attrs.language}`;
      pre.append(contentDOM);
      if (!mermaid) return {
        dom: pre, contentDOM,
        update: next => next.type === node.type && next.attrs.language === node.attrs.language,
      };

      const dom = document.createElement("div");
      dom.className = "mermaid-block";
      const preview = document.createElement("div");
      preview.className = "mermaid-preview";
      preview.contentEditable = "false";
      dom.append(pre, preview);
      const idPrefix = `note-mermaid-${++diagramId}-`;
      let current = node;
      let source: string | undefined;
      let generation = 0;
      let destroyed = false;
      let editing = false;
      let cancel: (() => void) | undefined;
      let cancelCommit: (() => void) | undefined;
      const commit = (version: number, update: () => void) => {
        cancelCommit?.();
        cancelCommit = commitViewportLayout(preview, () => {
          if (!destroyed && version === generation) update();
        });
      };
      const render = async () => {
        const version = ++generation;
        const text = current.textContent;
        commit(version, () => {
          preview.classList.remove("has-error");
          preview.textContent = text.trim() ? "Loading diagram…" : "Empty Mermaid diagram";
        });
        if (!text.trim()) return;
        try {
          const { renderAsync } = await import("pele/lazy");
          const result = await renderAsync(text, {
            idPrefix, responsive: true, links: false, images: false,
            fontFamily: getComputedStyle(dom).fontFamily,
            fontFamilyMono: getComputedStyle(contentDOM).fontFamily,
          });
          if (destroyed || version !== generation) return;
          commit(version, () => {
            preview.classList.remove("has-error");
            // Only Pele-generated SVG is HTML; source and errors stay text.
            preview.innerHTML = result.svg;
          });
        } catch (error) {
          if (destroyed || version !== generation) return;
          commit(version, () => {
            preview.classList.add("has-error");
            preview.textContent = error instanceof Error ? error.message : "Unable to render diagram";
          });
        }
      };
      const appearance = (nextDecorations: readonly Decoration[]) => {
        editing = editor.isEditable && nextDecorations.some(d => d.spec.mermaidEditing);
        pre.hidden = !editing;
        dom.contentEditable = editing ? "true" : "false";
        dom.classList.toggle("is-editing", editing);
        if (source === current.textContent) {
          if (editing && cancel) { cancel(); cancel = undefined; void render(); }
          return;
        }
        source = current.textContent;
        ++generation;
        cancel?.();
        cancel = undefined;
        if (editing) void render();
        else cancel = defer(preview, () => { cancel = undefined; void render(); });
      };
      preview.addEventListener("mousedown", event => {
        if (event.button !== 0 || !editor.isEditable) return;
        event.preventDefault();
        const pos = getPos();
        if (typeof pos !== "number") return;
        if (!editing) editor.view.dispatch(editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, pos + 1 + current.content.size),
        ));
        editor.view.focus();
      });
      appearance(decorations);
      return {
        dom, contentDOM,
        update(next, nextDecorations) {
          if (next.type !== current.type || !isMermaid(next)) return false;
          current = next;
          appearance(nextDecorations);
          return true;
        },
        destroy() { destroyed = true; ++generation; cancel?.(); cancelCommit?.(); },
        stopEvent: event => event.target instanceof window.Node && preview.contains(event.target),
        ignoreMutation: mutation => mutation.type !== "selection" && (
          preview.contains(mutation.target) ||
          (mutation.type === "attributes" && (mutation.target === pre || mutation.target === dom))
        ),
      };
    },
  };
}
