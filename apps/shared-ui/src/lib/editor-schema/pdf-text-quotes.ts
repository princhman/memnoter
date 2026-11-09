import { Node, mergeAttributes } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { parsePdfSource } from "../pdf-quote";

function quoteId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export const PdfTextQuote = Node.create({
  name: "pdfTextQuote",
  group: "block",
  content: "paragraph+",
  defining: true,
  addProseMirrorPlugins() {
    return [new Plugin({ props: {
      transformPasted(slice) {
        const copy = (fragment: Fragment): Fragment => {
          const nodes: import("@tiptap/pm/model").Node[] = [];
          let changed = false;
          fragment.forEach(node => {
            const content = copy(node.content);
            const next = node.type.name === "pdfTextQuote"
              ? node.type.create({ ...node.attrs, quoteId: crypto.randomUUID() }, content, node.marks)
              : content === node.content ? node : node.copy(content);
            changed ||= next !== node;
            nodes.push(next);
          });
          return changed ? Fragment.fromArray(nodes) : fragment;
        };
        const content = copy(slice.content);
        return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
      },
    } })];
  },
  addAttributes() {
    return {
      quoteId: {
        default: null,
        parseHTML: element => quoteId(element.getAttribute("data-quote-id")),
        renderHTML: attrs => quoteId(attrs.quoteId) ? { "data-quote-id": attrs.quoteId } : {},
      },
      pdfSource: {
        default: null,
        parseHTML: element => {
          try { return parsePdfSource(JSON.parse(element.getAttribute("data-pdf-source") || "null")); }
          catch { return null; }
        },
        renderHTML: attrs => {
          const source = parsePdfSource(attrs.pdfSource);
          return source ? { "data-pdf-source": JSON.stringify(source) } : {};
        },
      },
    };
  },
  parseHTML() { return [{ tag: "blockquote[data-pdf-text-quote]", priority: 60 }]; },
  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(HTMLAttributes, { "data-pdf-text-quote": "" }), 0];
  },
});
