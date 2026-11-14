import { Mark } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

// Persist the distinction without putting escape syntax in copied text.
export const LiteralDollar = Mark.create({
  name: "literalDollar",
  inclusive: false,
  parseHTML: () => [{ tag: "span[data-literal-dollar]" }],
  renderHTML: () => ["span", { "data-literal-dollar": "" }, 0],
  addProseMirrorPlugins() {
    const type = this.type;
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(tr => tr.docChanged)) return null;
        const matches: number[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.spec.code || node.marks.some(mark => mark.type.spec.code)) return false;
          if (node.isText) {
            for (const match of node.text!.matchAll(/\\\$/g)) matches.push(pos + match.index);
          }
        });
        if (!matches.length) return null;
        const tr = state.tr;
        for (const pos of matches.reverse()) {
          const marks = state.doc.resolve(pos + 1).marks().filter(mark => mark.type !== type);
          tr.replaceWith(pos, pos + 2, state.schema.text("$", [...marks, type.create()]));
        }
        return tr;
      },
    })];
  },
});
