import { outline } from "./outline.ts";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Missing heading levels do not invent empty chapters: H1 → H3 is 1 → 1.1.
export function headingNumbers(doc: Node) {
  const result = new Map<number, string>();
  const stack: { level: number; number: number }[] = [];
  for (const { pos, level } of outline(doc)) {
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
    // Selection-only transactions keep the immutable document and its numbers.
    const cache = new WeakMap<Node, DecorationSet>();
    return [new Plugin({
      key: headingNumberingKey,
      state: {
        init: () => false,
        apply: (tr, enabled) => tr.getMeta(headingNumberingKey) ?? enabled,
      },
      props: {
        decorations(state) {
          if (!headingNumberingKey.getState(state)) return null;
          const cached = cache.get(state.doc);
          if (cached) return cached;
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
              key: `heading-number-${number}`,
            }),
          ));
          cache.set(state.doc, decorations);
          return decorations;
        },
      },
    })];
  },
});
