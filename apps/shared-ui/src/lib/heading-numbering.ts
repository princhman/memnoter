import { outline } from "./outline.ts";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Missing heading levels do not invent empty chapters: H1 → H3 is 1 → 1.1.
export function headingNumbers(doc: Node) {
  return numberHeadings(outline(doc));
}

export function numberHeadings(headings: readonly { pos: number; level: number }[]) {
  const result = new Map<number, string>();
  const stack: { level: number; number: number }[] = [];
  for (const { pos, level } of headings) {
    let previous = 0;
    while (stack.length && stack[stack.length - 1].level > level) previous = stack.pop()!.number;
    if (stack[stack.length - 1]?.level === level) stack[stack.length - 1].number++;
    else stack.push({ level, number: previous + 1 });
    result.set(pos, stack.map(entry => entry.number).join("."));
  }
  return result;
}
export const headingNumberingKey = new PluginKey<boolean>("headingNumbering");
export const HeadingNumbering = Extension.create({
  name: "headingNumbering",
  addProseMirrorPlugins() {
    // Only retain the current document's labels. A content change must rebuild
    // them, including a Yjs update that removes or returns a whole section.
    let cached: { doc: Node; decorations: DecorationSet } | undefined;
    return [new Plugin({
      key: headingNumberingKey,
      state: {
        init: () => false,
        apply: (tr, enabled) => {
          if (tr.docChanged || tr.getMeta(headingNumberingKey) !== undefined) cached = undefined;
          return tr.getMeta(headingNumberingKey) ?? enabled;
        },
      },
      props: {
        decorations(state) {
          if (!headingNumberingKey.getState(state)) return null;
          if (cached?.doc === state.doc) return cached.decorations;
          const decorations = DecorationSet.create(state.doc, [...headingNumbers(state.doc)].map(([pos, number]) =>
            Decoration.widget(pos + 1, (view) => {
              const span = view.dom.ownerDocument.createElement("span");
              span.className = "heading-number";
              span.contentEditable = "false";
              span.setAttribute("aria-hidden", "true");
              span.textContent = `${number}\u00a0`;
              return span;
            }, {
              // Keep the caret and newly typed text after the number, including
              // in an empty heading with only ProseMirror's trailing break.
              side: -1,
              ignoreSelection: true,
              // The same ordinal can belong to a different heading after a
              // move. Reusing its widget across headings can retain stale DOM.
              key: `heading-number-${state.doc.nodeAt(pos)?.attrs["data-toc-id"] ?? pos}-${number}`,
            }),
          ));
          cached = { doc: state.doc, decorations };
          return decorations;
        },
      },
    })];
  },
});
