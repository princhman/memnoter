import { Extension, type JSONContent } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { looksLikeMarkdown, markdownToJSON } from "./markdown-paste.ts";

// Older schemas retain readable content, including table cells and formulas.
function compatible(node: JSONContent, schema: Schema): JSONContent[] {
  const content = node.content?.flatMap(child => compatible(child, schema));
  const tableTypes = ["table", "tableRow", "tableHeader", "tableCell"];
  if (!schema.nodes[node.type ?? ""] || (tableTypes.includes(node.type ?? "") && tableTypes.some(type => !schema.nodes[type]))) {
    if (["heading", "codeBlock", "mathBlock"].includes(node.type ?? "")) return [{ type: "paragraph", content }];
    if (node.type === "hardBreak") return [{ type: "text", text: "\n" }];
    if (node.type === "horizontalRule") return [{ type: "paragraph", content: [{ type: "text", text: "---" }] }];
    return content ?? [];
  }
  return [{ ...node, ...(content ? { content } : {}), ...(node.marks ? { marks: node.marks.filter(mark => schema.marks[mark.type]) } : {}) }];
}

export const MarkdownPaste = Extension.create({
  name: "markdownPaste",
  priority: 1100,
  addProseMirrorPlugins() {
    let literal = false;
    return [new Plugin({
      props: {
        handleDOMEvents: {
          keydown(_view, event) { literal = event.shiftKey && (event.metaKey || event.ctrlKey); return false; },
          keyup() { literal = false; return false; },
          blur() { literal = false; return false; },
          paste(view, event) {
            const data = event.clipboardData;
            const bypass = literal;
            literal = false;
            if (view.editable === false || !data || data.files.length || Array.from(data.items ?? []).some(item => item.kind === "file")) return false;
            // Internal editor HTML carries identities and an exact PM slice.
            if (!bypass && /data-pm-slice\s*=/i.test(data.getData("text/html"))) return false;
            // Menus and find inputs can live under the editor's DOM tree.
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("input, textarea, [contenteditable='false']")) return false;
            const { $from, $to } = view.state.selection;
            for (const $pos of [$from, $to]) {
              for (let depth = $pos.depth; depth > 0; depth--) {
                const node = $pos.node(depth);
                if (node.type.spec.code || ["inlineMath", "mathBlock"].includes(node.type.name)) return false;
              }
            }
            // Explicit Markdown source wins over external HTML; prose keeps
            // the existing HTML paste path (including Obsidian reading view).
            const source = data.getData("text/plain");
            if (!source || (!bypass && !looksLikeMarkdown(source))) return false;
            const converted: JSONContent = bypass
              ? { type: "doc", content: source.split(/\r?\n/).map(line => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) }
              : markdownToJSON(source);
            const json = compatible(converted, view.state.schema)[0];
            const doc = view.state.schema.nodeFromJSON(json);
            doc.check();
            // Open only paragraph edges: plain text can join the current block,
            // while explicit headings, lists and math keep their block identity.
            const openEdge = (node: typeof doc.firstChild) => node?.type.name === "paragraph" && !/^\[(?:image|embed): .+\]$/.test(node.textContent) ? 1 : 0;
            const first = openEdge(doc.firstChild);
            const last = openEdge(doc.lastChild);
            const slice = new Slice(Fragment.from(doc.content), first, last);
            const undoManager = yUndoPluginKey.getState(view.state)?.undoManager;
            undoManager?.stopCapturing();
            const tr = closeHistory(view.state.tr).replaceSelection(slice).scrollIntoView();
            // Don't set uiEvent=paste: TipTap's paste rules would reinterpret
            // literal card/math/code contents that have already been parsed.
            view.dispatch(tr);
            undoManager?.stopCapturing();
            event.preventDefault();
            return true;
          },
        },
      },
    })];
  },
});
