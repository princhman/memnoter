import type { JSONContent } from "@tiptap/core";

// A card is one paragraph of inline content (cards.ts), so Anki's block markup
// is flattened into lines: lists become "- " / "1. " lines, code blocks become
// code-marked lines, images are returned separately for the caller to place
// beside the card.

type Mark = { type: string; attrs?: Record<string, unknown> };
export type AnkiImageRef = { src: string; alt: string };
export type AnkiInline = { lines: JSONContent[][]; images: AnkiImageRef[] };

const BLOCK_TAGS = new Set(["div", "p", "ul", "ol", "li", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "hr"]);
const MARK_TAGS: Record<string, string> = { b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline", s: "strike", strike: "strike", del: "strike", code: "code" };
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ZERO_WIDTH_SPACE = "​";

export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value);
};

const sameMarks = (a?: Mark[], b?: Mark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function pushText(line: JSONContent[], text: string, marks: Mark[]) {
  if (!text) return;
  const last = line[line.length - 1];
  if (last?.type === "text" && sameMarks(last.marks, marks)) last.text += text;
  else line.push({ type: "text", text, ...(marks.length ? { marks: marks.map(mark => ({ ...mark })) } : {}) });
}

/** `\(x\)` and `\[x\]` become inline math nodes; the rest stays text. */
function pushWithMath(line: JSONContent[], text: string, marks: Mark[]) {
  const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
  let from = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const tex = (match[1] ?? match[2]).replace(/ /g, " ").trim();
    if (!tex) continue;
    pushText(line, text.slice(from, match.index), marks);
    line.push({ type: "inlineMath", content: [{ type: "text", text: tex }] });
    from = match.index + match[0].length;
  }
  pushText(line, text.slice(from), marks);
}

function trimLine(line: JSONContent[]) {
  const first = line[0], last = line[line.length - 1];
  // List indentation is made of non-breaking spaces so it survives.
  if (first?.type === "text" && !first.marks?.some(mark => mark.type === "code")) first.text = first.text!.replace(/^ +/, "");
  if (last?.type === "text" && !last.marks?.some(mark => mark.type === "code")) last.text = last.text!.replace(/[  ]+$/, "");
  return line.filter(node => node.type !== "text" || node.text);
}

export function htmlToLines(html: string): AnkiInline {
  const lines: JSONContent[][] = [];
  const images: AnkiImageRef[] = [];
  let line: JSONContent[] = [];
  const marks: Mark[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  let pre = 0;
  // A line break is only wanted when something precedes it.
  const endLine = (force = false) => {
    if (line.length || force) lines.push(trimLine(line));
    line = [];
  };
  const source = html.replace(/\[sound:[^\]]*\]/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  for (const token of source.match(/<[^>]*>|[^<]+|</g) ?? []) {
    if (token[0] !== "<" || token === "<") {
      const text = decodeEntities(token === "<" ? "<" : token);
      if (pre) {
        text.split("\n").forEach((part, index) => {
          if (index) endLine(true);
          pushText(line, part, [...marks.filter(mark => mark.type !== "code"), { type: "code" }]);
        });
      } else pushWithMath(line, text.replace(/[\s ]+/g, " "), marks);
      continue;
    }
    const closing = token[1] === "/";
    const name = /^<\/?\s*([a-z0-9]+)/i.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (name === "br") { endLine(true); continue; }
    if (name === "img") {
      const src = attribute(token, "src");
      if (src) images.push({ src, alt: attribute(token, "alt") ?? "" });
      continue;
    }
    if (name === "pre") pre += closing ? (pre ? -1 : 0) : 1;
    if (name in MARK_TAGS) {
      if (!closing) marks.push({ type: MARK_TAGS[name] });
      else { const at = marks.map(mark => mark.type).lastIndexOf(MARK_TAGS[name]); if (at >= 0) marks.splice(at, 1); }
      continue;
    }
    if (name === "a") {
      const href = closing ? undefined : attribute(token, "href");
      if (closing) { const at = marks.map(mark => mark.type).lastIndexOf("link"); if (at >= 0) marks.splice(at, 1); }
      else if (href && /^https?:\/\//i.test(href)) marks.push({ type: "link", attrs: { href } });
      continue;
    }
    if (name === "ul" || name === "ol") {
      if (closing) lists.pop(); else lists.push({ ordered: name === "ol", count: 0 });
      endLine();
      continue;
    }
    if (name === "li") {
      endLine();
      if (!closing && lists.length) {
        const list = lists[lists.length - 1];
        list.count++;
        pushText(line, `${"  ".repeat(lists.length - 1)}${list.ordered ? `${list.count}.` : "-"} `, []);
      }
      continue;
    }
    if (BLOCK_TAGS.has(name)) endLine();
    else if (name === "td" || name === "th") { if (!closing && line.length) pushText(line, "  ", marks); }
  }
  endLine();
  // Blank lines between lines are kept once; they cannot lead or trail.
  const result: JSONContent[][] = [];
  for (const entry of lines) {
    if (!entry.length && (!result.length || !result[result.length - 1].length)) continue;
    result.push(entry);
  }
  while (result.length && !result[result.length - 1].length) result.pop();
  return { lines: result, images };
}

export const hasContent = (lines: JSONContent[][]) => lines.some(line => line.some(node => node.type === "inlineMath" || node.text?.trim()));

/** Lines as one inline run, joined by hard breaks. */
export function joinLines(lines: JSONContent[][]): JSONContent[] {
  return lines.flatMap((line, index) => index ? [{ type: "hardBreak" } as JSONContent, ...line] : line);
}

/**
 * Stops text from being read as card syntax: a standalone `::`/`:::` or a
 * `{{`. Code and math are never syntax, so they are left alone.
 */
export function defuse(inline: JSONContent[], { clozes = true, separators = true }: { clozes?: boolean; separators?: boolean } = {}): JSONContent[] {
  return inline.map(node => {
    if (node.type !== "text" || node.marks?.some(mark => mark.type === "code")) return node;
    let text = node.text!;
    if (separators) text = text.replace(/(?<!\S)(:{2,3})(?!\S)/g, `$1${ZERO_WIDTH_SPACE}`);
    if (clozes) text = text.replace(/\{\{/g, `{${ZERO_WIDTH_SPACE}{`);
    return { ...node, text };
  });
}

/** Anki cloze `{{c1::answer::hint}}` as `{{answer}}`; the hint is dropped. */
export function clozeToHtml(html: string) {
  return html.replace(/\{\{c\d+::([\s\S]*?)(?:::[^{}<>]*?)?\}\}/g, "{{$1}}");
}
