import MarkdownIt, { type Token } from "markdown-it";
import type { JSONContent } from "@tiptap/core";

type Mark = NonNullable<JSONContent["marks"]>[number];
const text = (value: string, marks: Mark[] = []): JSONContent => ({ type: "text", text: value, ...(marks.length ? { marks: [...new Map(marks.map(mark => [mark.type, mark])).values()] } : {}) });
const paragraph = (content: JSONContent[] = []): JSONContent => ({ type: "paragraph", content });
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Ask the block parser for code ranges instead of rewriting their contents.
// Inline code/math alternatives similarly shield their raw source from comments.
function stripMetadata(source: string) {
  source = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
  const lines = source.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const ranges = new Map<number, number>();
  for (const token of md.parse(source, {})) {
    if (["fence", "code_block", "obsidian_math_block"].includes(token.type) && token.map) {
      ranges.set(offsets[token.map[0]], Math.min(source.length, offsets[token.map[1]]));
    }
  }
  let result = "";
  for (let pos = 0; pos < source.length;) {
    const end = ranges.get(pos);
    if (end !== undefined) { result += source.slice(pos, end); pos = end; continue; }
    if (source.startsWith("%%", pos)) {
      const close = source.indexOf("%%", pos + 2);
      if (close !== -1) { pos = close + 2; continue; }
    }
    const literal = /[`$]/.test(source[pos]) && /^(?:(`+)[\s\S]*?\1(?!`)|\$\$[\s\S]*?\$\$|\$[^\n$]+\$)/.exec(source.slice(pos));
    if (literal) { result += literal[0]; pos += literal[0].length; }
    else { result += source[pos]; pos++; }
  }
  return result;
}

md.block.ruler.before("fence", "obsidian_math", (state, start, end, silent) => {
  const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = line(start);
  if (!first.startsWith("$$")) return false;
  let last = start;
  let value = first.slice(2);
  if (!value.trimEnd().endsWith("$$")) {
    while (++last < end && !line(last).trimEnd().endsWith("$$")) { /* find closing delimiter */ }
    if (last >= end) return false;
    value = [value, ...Array.from({ length: last - start }, (_, i) => line(start + i + 1))].join("\n");
  }
  if (!value.trimEnd().endsWith("$$")) return false;
  if (silent) return true;
  const token = state.push("obsidian_math_block", "", 0);
  token.map = [start, last + 1];
  token.content = value.trimEnd().slice(0, -2).replace(/^\n|\n$/g, "");
  state.line = last + 1;
  return true;
}, { alt: ["paragraph", "blockquote", "list"] });

md.inline.ruler.before("escape", "obsidian", (state, silent) => {
  const remaining = state.src.slice(state.pos, state.posMax);
  const emit = (type: string, value: string, length: number) => {
    if (!silent) state.push(type, "", 0).content = value;
    state.pos += length;
    return true;
  };
  if (remaining.startsWith("$$")) {
    const end = remaining.indexOf("$$", 2);
    if (end !== -1) return emit("obsidian_math_display", remaining.slice(2, end).replace(/^\n|\n$/g, ""), end + 2);
    return false;
  }
  if (remaining.startsWith("$ ")) return false;
  if (remaining[0] === "$" && !/\s/.test(remaining[1] ?? " ")) {
    let end = 1;
    while ((end = remaining.indexOf("$", end)) !== -1) {
      if (remaining[end - 1] === "\\") { end++; continue; }
      const value = remaining.slice(1, end);
      if (!value.includes("\n") && !/\s$/.test(value) && !/^\d/.test(remaining[end + 1] ?? "") && !/^[\d,.\s]+$/.test(value)) {
        return emit("obsidian_math_inline", value, end + 1);
      }
      break;
    }
  }
  const wiki = /^(!?)\[\[([^\]\n]+)\]\]/.exec(remaining);
  if (wiki) {
    const [target, alias] = wiki[2].split("|");
    const name = target.split("#")[0] || target.slice(1);
    const image = /\.(?:png|jpe?g|gif|webp|svg|avif|heic|bmp|tiff?)$/i.test(target);
    if (wiki[1] && image) {
      if (!silent) { const token = state.push("obsidian_image", "", 0); token.content = target; token.meta = { width: /^\d+$/.test(alias ?? "") ? Number(alias) : undefined }; }
      state.pos += wiki[0].length;
      return true;
    }
    if (!wiki[1] && state.env?.keepWikiLinks) {
      if (!silent) {
        const [path, fragment] = target.split("#");
        const href = /\.md$/i.test(path) ? path : `${path}.md`;
        state.push("link_open", "a", 1).attrSet("href", `${href}${fragment ? `#${fragment}` : ""}`);
        state.push("text", "", 0).content = alias || name;
        state.push("link_close", "a", -1);
      }
      state.pos += wiki[0].length;
      return true;
    }
    return emit(wiki[1] ? "obsidian_placeholder" : "text", wiki[1] ? `[${image ? "image" : "embed"}: ${image ? target.split(/[\\/]/).pop() : target}]` : alias || name, wiki[0].length);
  }
  const highlight = /^==(?=\S)((?:(`+)[\s\S]*?\2(?!`)|\$[^$\n]+\$|(?!=)[\s\S]|=(?!=))+?)==/.exec(remaining);
  if (highlight) {
    if (!silent) {
      const token = state.push("obsidian_highlight", "", 0);
      token.children = md.parseInline(highlight[1], state.env)[0].children;
    }
    state.pos += highlight[0].length;
    return true;
  }
  // A trailing block id is metadata only outside code/math, at a line end.
  const id = /^\^[a-zA-Z0-9-]+(?=\n|$)/.exec(remaining);
  if (id && state.pos > 0 && state.src[state.pos - 1] === " ") {
    if (!silent) state.pending = state.pending.trimEnd();
    state.pos += id[0].length;
    return true;
  }
  return false;
});

// `::` or `:::` with only space (or math, as a space here) beside it, as cards.ts parses it.
const CARD_SEPARATOR = /(?<!\S):{2,3}(?!\S)/;

export type ImageResolver = (target: string, alt: string, width?: number, syntax?: "markdown" | "wiki") => JSONContent | undefined;

function inlines(tokens: Token[], inherited: Mark[] = [], resolveImage?: ImageResolver): JSONContent[] {
  const result: JSONContent[] = [];
  const marks = [...inherited];
  for (const token of tokens) {
    const type = ({ strong: "bold", em: "italic", s: "strike", link: "link" } as Record<string, string>)[token.type.replace(/_(open|close)$/, "")];
    if (token.nesting === 1 && type) marks.push({ type, ...(type === "link" ? { attrs: { href: token.attrGet("href") } } : {}) });
    else if (token.nesting === -1 && type) marks.pop();
    else if (token.type === "text" && token.content) result.push(text(token.content, marks));
    else if (token.type === "code_inline") result.push(text(token.content, [{ type: "code" }]));
    else if (token.type === "softbreak") result.push(text("\n", marks));
    else if (token.type === "hardbreak") result.push({ type: "hardBreak" });
    else if (token.type === "obsidian_math_display") result.push({ type: "mathBlock", content: token.content ? [text(token.content)] : [] });
    else if (token.type === "obsidian_math_inline") {
      // Keep `==a $x$ b==` highlighted across the formula, as the editor does.
      const highlight = marks.filter(mark => mark.type === "highlight");
      result.push({ type: "inlineMath", content: [text(token.content)], ...(highlight.length ? { marks: highlight } : {}) });
    }
    else if (token.type === "obsidian_highlight") result.push(...inlines(token.children ?? [], [...marks, { type: "highlight", attrs: { color: "yellow" } }], resolveImage));
    else if (token.type === "obsidian_placeholder") result.push({ type: "pastePlaceholder", content: [text(token.content)] });
    else if (token.type === "obsidian_image") result.push(resolveImage?.(token.content, "", typeof token.meta?.width === "number" ? token.meta.width : undefined, "wiki") ?? { type: "pastePlaceholder", content: [text(`[image: ${token.content.split(/[\\/]/).pop()}]`)] });
    else if (token.type === "image") {
      const src = String(token.attrGet("src") ?? "");
      if (/^https?:\/\//i.test(src)) result.push(text(token.content || src, [...marks, { type: "link", attrs: { href: src } }]));
      else result.push(resolveImage?.(src, token.content, undefined, "markdown") ?? { type: "pastePlaceholder", content: [text(`[image: ${src.split(/[\\/]/).pop()}]`)] });
    }
  }
  return result;
}

/** Schema-independent TipTap JSON; never fetches files or generates identities. */
export type MarkdownImportOptions = { removeNoteLinks?: boolean; removeUnsupportedEmbeds?: boolean; keepFrontMatter?: boolean };
export function markdownToJSON(source: string, resolveImage?: ImageResolver, options: MarkdownImportOptions = {}): JSONContent {
  // Retain YAML as literal data, rather than interpreting its delimiters as headings.
  const front = options.keepFrontMatter && /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  if (front) source = source.slice(front[0].length);
  const tokens = md.parse(stripMetadata(source), { keepWikiLinks: options.removeNoteLinks === false });
  function clean(tokens: Token[]): Token[] {
    return tokens.filter(token => !(options.removeUnsupportedEmbeds && (
      (token.type === "obsidian_placeholder" && token.content.startsWith("[embed:")) ||
      (token.type === "image" && /\.(?:pdf|mp4|mp3|wav|mov|docx?|pptx?|xlsx?|zip)(?:[?#].*)?$/i.test(String(token.attrGet("src") ?? "")))
    ))).map(token => {
      if (token.children) {
        if (options.removeNoteLinks && token.type === "inline" && !token.children.some(child => child.type === "code_inline" && child.content.includes("\n"))) {
          const kept = token.content.split("\n").filter(line => !/^\s*(?:\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\((?![a-z]+:)[^)]*\.md(?:#[^)]*)?\))\s*$/i.test(line)).join("\n");
          if (kept !== token.content) {
            token.content = kept;
            token.children = md.parseInline(kept, {})[0].children ?? [];
          }
        }
        {
          // Closing link tokens carry no href. Remove matched pairs together.
          let noteLink = false;
          token.children = token.children.filter(child => {
            if (child.type === "link_open") noteLink = !!options.removeNoteLinks && /^(?![a-z]+:|\/\/)[^?#]*\.md(?:[?#].*)?$/i.test(String(child.attrGet("href") ?? ""));
            if (child.type === "link_close") { const drop = noteLink; noteLink = false; return !drop; }
            return !(child.type === "link_open" && noteLink);
          });
          token.children = clean(token.children);
        }
      }
      return token;
    });
  }
  clean(tokens);
  const root: JSONContent = { type: "doc", content: [] };
  if (front) root.content!.push({ type: "codeBlock", attrs: { language: "yaml" }, content: [text(front[1])] });
  const stack = [root];
  const add = (node: JSONContent) => stack[stack.length - 1].content!.push(node);
  for (const token of tokens) {
    if (token.type === "inline") {
      // Callout markers only count at the start of a quoted paragraph.
      let value = token.content;
      const parent = stack[stack.length - 1];
      const callout = stack.some(node => node.type === "blockquote") && /^\[!([\w-]+)\][+-]?(?:[ \t]+([^\n]*))?(?:\n|$)/.exec(value);
      if (callout) {
        const title = callout[2] || callout[1];
        parent.content!.push(...inlines(md.parseInline(title, {})[0].children ?? [], [{ type: "bold" }], resolveImage));
        value = value.slice(callout[0].length);
        if (value) parent.content!.push(text("\n"));
      }
      if (stack.some(node => node.type === "listItem")) value = value.replace(/^\[([ xX])\](?:[ \t]+|$)/, (_, done) => done === " " ? "☐ " : "☑ ");
      parent.content!.push(...inlines(value === token.content ? token.children ?? [] : md.parseInline(value, {})[0].children ?? [], [], resolveImage));
    } else if (token.type === "fence" || token.type === "code_block") {
      add({ type: "codeBlock", attrs: { language: token.info.trim().split(/\s/)[0] || null }, content: token.content ? [text(token.content.replace(/\n$/, ""))] : [] });
    } else if (token.type === "obsidian_math_block") add({ type: "mathBlock", content: token.content ? [text(token.content)] : [] });
    else if (token.type === "hr") add({ type: "horizontalRule" });
    else if (token.nesting === 1) {
      const type = ({ paragraph: "paragraph", heading: "heading", bullet_list: "bulletList", ordered_list: "orderedList", list_item: "listItem", blockquote: "blockquote", table: "table", tr: "tableRow", th: "tableHeader", td: "tableCell" } as Record<string, string>)[token.type.replace(/_open$/, "")];
      if (!type) continue; // thead/tbody are structural wrappers only
      const node: JSONContent = { type, content: [], ...(type === "heading" ? { attrs: { level: Number(token.tag.slice(1)) } } : type === "orderedList" ? { attrs: { start: Number(token.attrGet("start") || 1) } } : {}) };
      add(node);
      stack.push(node);
      // Table inline tokens have no paragraph wrapper.
      if (type === "tableHeader" || type === "tableCell") { const p = paragraph(); node.content!.push(p); stack.push(p); }
    } else if (token.nesting === -1 && !["thead_close", "tbody_close"].includes(token.type)) {
      if (token.type === "th_close" || token.type === "td_close") stack.pop();
      stack.pop();
    }
  }
  // Obsidian cards are one per line (`Front ::: Back`), but a note card is one
  // per paragraph. Give each line its own paragraph when any line is a card.
  function cardLines(node: JSONContent): JSONContent[] {
    const lines: JSONContent[][] = [[]];
    for (const child of node.content ?? []) {
      if (child.type === "text" && child.text === "\n") lines.push([]);
      else lines[lines.length - 1].push(child);
    }
    const prose = (line: JSONContent[]) => line.map(child => child.type === "text" && !child.marks?.some(mark => mark.type === "code") ? child.text : " ").join("");
    if (lines.length < 2 || lines.some(line => prose(line).includes("{{")) || !lines.some(line => CARD_SEPARATOR.test(prose(line)))) return [node];
    return lines.filter(line => line.length).map(content => ({ ...node, content }));
  }
  // Image placeholders always occupy their own paragraph, including in lists.
  function split(node: JSONContent): JSONContent[] {
    if (node.type === "paragraph" || node.type === "heading") {
      const result: JSONContent[] = [];
      let run: JSONContent[] = [];
      for (const child of node.content ?? []) {
        if (child.type === "pastePlaceholder" || child.type === "mathBlock" || child.type === "image") {
          if (run.length) result.push({ ...node, content: run });
          result.push(child.type !== "pastePlaceholder" ? child : paragraph(child.content)); run = [];
        } else run.push(child);
      }
      if (run.length || !result.length) result.push({ ...node, content: run });
      return node.type === "paragraph" ? result.flatMap(cardLines) : result;
    }
    let content = node.content?.flatMap(split);
    // Note cells allow paragraphs and images. Keep display formulas as inline
    // math in a paragraph so both paste and folder import fit the same schema.
    if (node.type === "tableCell" || node.type === "tableHeader") {
      content = content?.map(child => child.type === "mathBlock"
        ? paragraph([{ type: "inlineMath", content: child.content }]) : child);
    }
    // ProseMirror list items require a paragraph first, even when an Obsidian
    // item starts with an image or display formula.
    if (node.type === "listItem" && content?.[0]?.type !== "paragraph") content?.unshift(paragraph());
    return [{ ...node, ...(content ? { content } : {}) }];
  }
  if (!root.content!.length) root.content!.push(paragraph());
  return split(root)[0];
}

/** Require explicit structure or paired markup; plain prose remains native paste. */
export function looksLikeMarkdown(source: string): boolean {
  if (/^(?: {0,3}#{1,6}\s+\S| {0,3}[-+*]\s+\S| {0,3}\d+[.)]\s+\S| {0,3}>\s+\S| {0,3}(?:`{3,}|~{3,})|\s*(?:---+|\*\s*\*\s*\*|-\s*-\s*-)\s*$)/m.test(source)) return true;
  const doc = markdownToJSON(source);
  function rich(node: JSONContent): boolean {
    return Boolean(node.marks?.length || !["doc", "paragraph", "text"].includes(node.type ?? "") || node.content?.some(rich));
  }
  // Wiki links and removed metadata intentionally become ordinary text.
  return rich(doc) || /!?\[\[[^\]\n]+\]\]|%%[\s\S]*?%%| \^[\w-]+\s*$/.test(source);
}
