import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { codeLanguage, loadGrammar } from "./code-languages";

const key = new PluginKey<DecorationSet>("codeHighlighting");
// Keep regex tokenization bounded on generated or minified files.
const maxHighlightedLength = 12_000;

export function codeHighlighting() {
  type Language = NonNullable<ReturnType<typeof codeLanguage>>;
  const grammars = new Map<Language, ((source: string) => string) | null>();
  let view: EditorView | undefined;

  function highlight(doc: Node, from: number, to: number, only?: Language) {
    const decorations: Decoration[] = [];
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== "codeBlock") return;
      const language = codeLanguage(node.attrs.language);
      if (!language || (only && only !== language) ||
          !node.content.size || node.content.size > maxHighlightedLength) return false;
      const grammar = grammars.get(language);
      if (!grammar) {
        if (!grammars.has(language)) {
          grammars.set(language, null);
          void loadGrammar(language).then(loaded => {
            grammars.set(language, loaded);
            if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, language));
          }, () => { /* Plain text stays editable if a grammar chunk is unavailable. */ });
        }
        return false;
      }

      const template = document.createElement("template");
      // highlight.js escapes the source before enclosing tokens in spans.
      template.innerHTML = grammar(node.textContent).replace(/\r/g, "&#13;").replace(/\0/g, "\uFFFD");
      let offset = pos + 1;
      function visit(element: ParentNode, classes: string) {
        for (const child of element.childNodes) {
          if (child instanceof HTMLElement) {
            visit(child, [classes, child.className].filter(Boolean).join(" "));
          } else if (child.nodeType === window.Node.TEXT_NODE) {
            const end = offset + (child.textContent?.length ?? 0);
            if (classes && end > offset) decorations.push(Decoration.inline(offset, end, { class: classes }));
            offset = end;
          }
        }
      }
      visit(template.content, "");
      return false;
    });
    return decorations;
  }

  return new Plugin({
    key,
    state: {
      init: (_, { doc }) => DecorationSet.create(doc, highlight(doc, 0, doc.content.size)),
      apply(tr, set, { doc: before }, { doc }) {
        const loaded = codeLanguage(tr.getMeta(key));
        if (loaded) return set.add(doc, highlight(doc, 0, doc.content.size, loaded));
        if (!tr.docChanged) return set;
        const start = before.content.findDiffStart(doc.content);
        const end = before.content.findDiffEnd(doc.content);
        if (start === null || !end) return set;
        // A repeated prefix/suffix can make diff endpoints overlap.
        const overlap = Math.max(0, start - Math.min(end.a, end.b));
        const oldEnd = end.a + overlap;
        const newEnd = end.b + overlap;
        const obsolete: Decoration[] = [];
        before.nodesBetween(Math.max(0, start - 1), Math.min(oldEnd + 1, before.content.size), (node, pos) => {
          if (node.type.name !== "codeBlock") return;
          obsolete.push(...set.find(pos + 1, pos + node.nodeSize - 1));
          return false;
        });
        const mapping = new Mapping([new StepMap([start, oldEnd - start, newEnd - start])]);
        return set.remove(obsolete).map(mapping, doc).add(doc,
          highlight(doc, Math.max(0, start - 1), Math.min(newEnd + 1, doc.content.size)));
      },
    },
    props: { decorations: state => key.getState(state) },
    view(editorView) {
      view = editorView;
      return { destroy() { view = undefined; } };
    },
  });
}
