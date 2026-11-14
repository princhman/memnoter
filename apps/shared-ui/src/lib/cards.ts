import { outline } from "./outline.ts";
import { basicCardId, clozeCardId, occlusionCardId, parseCardId } from "./card-id.ts";
export { blockIdOf } from "./card-id.ts";

import { highlightColor } from "./highlight.ts";
import { maskCards, validMasks, type OcclusionFace } from "./occlusion.ts";
import type { Node } from "@tiptap/pm/model";
import type { StepMap } from "@tiptap/pm/transform";

export function isImageNode(node: Node | null | undefined): boolean {
  return node?.type.name === "image" || node?.type.name === "inlineImage";
}

// Flashcards written in note text. A paragraph or heading is a card block:
//   - Basic: `Question :: Answer`. The first `::` with no text character
//     directly on either side splits the block, so `std::vector` stays prose.
//   - Two-way: `Front ::: Back` makes forward and reverse basic cards.
//     Exactly two or three colons match; four colons stay prose.
//   - Cloze: `{{hidden}}`. Each cloze is its own card; the review shows the
//     whole block with that cloze hidden and the other clozes as plain text.
//   - A block with a cloze is a cloze block; any `::` or `:::` in it is plain text.
//   - A math block marked as a cloze is one cloze card: its whole formula.
//   - Blocks marked as one cloze note share their context: each cloze in the
//     note is still its own card, but its review shows the whole note. A
//     foldable block can be a note too, holding all of its content.
// Text in inline code is never syntax. Inline math may appear on either side
// and inside a cloze. A card needs a non-empty front and answer.

// The review renderer switches on kind. Image occlusion adds "occlusion".
export type CardKind = "basic" | "cloze" | "occlusion" | "list";

export type Segment =
  | { type: "text"; text: string; marks?: string[]; highlightColor?: string }
  | { type: "math"; tex: string; highlightColor?: string; display?: boolean }
  | { type: "break" }
  // The answer of a cloze card, highlighted on the back.
  | { type: "cloze"; children: Segment[] }
  // The hidden cloze on the front.
  | { type: "blank" }
  // Another cloze of the block, also hidden on the front; review can show it
  // on its own, for context.
  | { type: "hidden"; children: Segment[] }
  // One block of a cloze note, in document order. List items keep their
  // nesting depth, and the first block of an item its marker.
  | { type: "block"; children: Segment[]; depth?: number; marker?: "bullet" | number; revealStep?: true };

export type CardPayload = Segment[] | OcclusionFace;

export type ExtractedCard = {
  // `<cardId>` for basic cards, `<cardId>:reverse` for their reverse, `<cardId>:<stable cloze id>` for clozes.
  id: string;
  blockId: string;
  kind: CardKind;
  front: CardPayload;
  back: CardPayload;
  // Titles of the headings the card sits under, outermost first.
  section: string[];
};

// Offsets are relative to the start of the block's content.
export type Range = { from: number; to: number };
export type ClozeId = Range & { id: string; answer: string };

export type BlockSyntax = {
  separator: Range | null;
  clozes: { open: Range; inner: Range; close: Range }[];
  // The cards this block yields once it has an id, without ids.
  cards: Omit<ExtractedCard, "id" | "blockId" | "section">[];
};

type Unit =
  | { type: "char"; char: string; marks: string[]; highlightColor?: string; syntax: boolean; at: number }
  | { type: "math"; tex: string; highlightColor?: string; at: number; size: number }
  | { type: "break"; at: number };

const KEPT_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "highlight"]);

function unitsOf(block: Node): Unit[] {
  const units: Unit[] = [];
  block.forEach((child, offset) => {
    const highlight = child.marks.find(mark => mark.type.name === "highlight");
    const color = highlight ? { highlightColor: highlightColor(highlight.attrs.color) } : {};
    if (child.isText) {
      const marks = child.marks.map((mark) => mark.type.name).filter((name) => KEPT_MARKS.has(name));
      const syntax = !child.marks.some((mark) => mark.type.spec.code || mark.type.name === "link");
      // Iterate code points so surrogate pairs stay whole; positions count
      // UTF-16 units, as ProseMirror does.
      let at = offset;
      for (const char of child.text!) {
        units.push({ type: "char", char, marks, ...color, syntax, at });
        at += char.length;
      }
    } else if (child.type.name === "inlineMath") {
      units.push({
        type: "math",
        ...color,
        tex: child.textContent.replace(/​/g, ""),
        at: offset,
        size: child.nodeSize,
      });
    } else if (child.type.name === "hardBreak") {
      units.push({ type: "break", at: offset });
    }
    // Inline images and other atoms are not card content.
  });
  return units;
}

const isSyntax = (unit: Unit | undefined, char: string) =>
  unit?.type === "char" && unit.syntax && unit.char === char;

const isWordChar = (unit: Unit | undefined) =>
  unit?.type === "char" && !/\s/.test(unit.char);

const hasContent = (units: Unit[]) =>
  units.some((unit) => unit.type === "math" || (unit.type === "char" && /\S/.test(unit.char)));

function unitEnd(unit: Unit) {
  if (unit.type === "char") return unit.at + unit.char.length;
  if (unit.type === "math") return unit.at + unit.size;
  return unit.at + 1;
}

function span(units: Unit[], from: number, to: number): Range {
  return { from: units[from].at, to: unitEnd(units[to - 1]) };
}

function trim(units: Unit[]) {
  const blank = (unit: Unit) =>
    unit.type === "break" || (unit.type === "char" && /\s/.test(unit.char));
  let start = 0;
  let end = units.length;
  while (start < end && blank(units[start])) start++;
  while (end > start && blank(units[end - 1])) end--;
  return units.slice(start, end);
}

function segmentsOf(units: Unit[]): Segment[] {
  const segments: Segment[] = [];
  for (const unit of units) {
    if (unit.type === "math") segments.push({ type: "math", tex: unit.tex, ...(unit.highlightColor ? { highlightColor: unit.highlightColor } : {}) });
    else if (unit.type === "break") segments.push({ type: "break" });
    else {
      const last = segments[segments.length - 1];
      const marks = unit.marks.length ? unit.marks : undefined;
      if (last?.type === "text" && String(last.marks) === String(marks) && last.highlightColor === unit.highlightColor) {
        last.text += unit.char;
      } else {
        segments.push({ type: "text", text: unit.char, ...(marks ? { marks } : {}), ...(unit.highlightColor ? { highlightColor: unit.highlightColor } : {}) });
      }
    }
  }
  return segments;
}

// A math block's formula, shown on its own line.
function displayMath(block: Node): Segment[] {
  const tex = block.textContent.trim();
  return tex ? [{ type: "math", tex, display: true }] : [];
}

export function parseBlock(block: Node): BlockSyntax {
  const syntax: BlockSyntax = { separator: null, clozes: [], cards: [] };
  // A formula's braces are LaTeX, never card syntax.
  if (block.type.spec.code) {
    const math = displayMath(block);
    if (block.attrs.cloze === true && math.length) {
      syntax.cards.push({ kind: "cloze", front: [{ type: "blank" }], back: [{ type: "cloze", children: math }] });
    }
    return syntax;
  }
  const units = unitsOf(block);

  // Clozes do not nest: the last `{{` before a `}}` opens it.
  const clozes: { open: number; close: number }[] = [];
  let open: number | null = null;
  for (let i = 0; i < units.length - 1; i++) {
    if (isSyntax(units[i], "{") && isSyntax(units[i + 1], "{")) {
      open = i;
      i++;
    } else if (open !== null && isSyntax(units[i], "}") && isSyntax(units[i + 1], "}")) {
      if (hasContent(units.slice(open + 2, i))) clozes.push({ open, close: i });
      open = null;
      i++;
    }
  }

  if (clozes.length > 0) {
    for (const { open, close } of clozes) {
      syntax.clozes.push({
        open: span(units, open, open + 2),
        inner: span(units, open + 2, close),
        close: span(units, close, close + 2),
      });
    }
    clozes.forEach((_, index) => {
      syntax.cards.push({ kind: "cloze", front: clozeSide(block, syntax, [index], false), back: clozeSide(block, syntax, [index], true) });
    });
    return syntax;
  }

  for (let i = 0; i < units.length - 1; i++) {
    const width = isSyntax(units[i + 2], ":") ? 3 : 2;
    if (
      isSyntax(units[i], ":") &&
      isSyntax(units[i + 1], ":") &&
      !isWordChar(units[i - 1]) &&
      !isWordChar(units[i + width])
    ) {
      syntax.separator = span(units, i, i + width);
      const front = trim(units.slice(0, i));
      const back = trim(units.slice(i + width));
      if (hasContent(front) && hasContent(back)) {
        syntax.cards.push({ kind: "basic", front: segmentsOf(front), back: segmentsOf(back) });
        if (width === 3) syntax.cards.push({ kind: "basic", front: segmentsOf(back), back: segmentsOf(front) });
      }
      break;
    }
  }
  return syntax;
}

// Joins text left split around a removed brace.
function mergeText(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (
      segment.type === "text" &&
      last?.type === "text" &&
      String(last.marks) === String(segment.marks) && last.highlightColor === segment.highlightColor
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

// Blocks that can carry a card id: textblocks of a type with the attribute.
// Code blocks have no card id; math blocks do, for whole-formula clozes.
export function isCardBlock(node: Node) {
  return node.isTextblock && "cardId" in node.attrs;
}

// The id a whole-formula cloze is stored under, after its block's id.
const MATH_CLOZE_ID = "math";

// Group membership uses stable cloze ids, so edits before an answer do not
// change which answers are reviewed together.
export function validatedClozeGroups(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.flatMap((group) => {
    if (!Array.isArray(group) || !group.every((id) => typeof id === "string" && id.length > 0)) return [];
    const ids = [...new Set<string>(group)].filter((id) => !used.has(id));
    if (ids.length < 2) return [];
    ids.forEach((id) => used.add(id));
    return [ids];
  });
}

function clozeSide(block: Node, syntax: BlockSyntax, targets: number[], reveal: boolean): Segment[] {
  const units = unitsOf(block);
  const selected = new Set(targets);
  const segments: Segment[] = [];
  let start = 0;
  syntax.clozes.forEach(({ open, inner, close }, index) => {
    segments.push(...segmentsOf(units.filter((unit) => unit.at >= start && unit.at < open.from)));
    const answer = segmentsOf(units.filter((unit) => unit.at >= inner.from && unit.at < inner.to));
    if (selected.has(index)) segments.push(reveal ? { type: "cloze", children: answer } : { type: "blank" });
    else if (reveal) segments.push(...answer);
    else segments.push({ type: "hidden", children: answer });
    start = close.to;
  });
  segments.push(...segmentsOf(units.filter((unit) => unit.at >= start)));
  return mergeText(segments);
}

// Attributes can come from pasted HTML or persisted documents, not just us.
// Reserve "reverse" for two-way basics; generated cloze ids start with c.
export function validatedClozeIds(value: unknown): ClozeId[] | null {
  if (!Array.isArray(value) || !value.every((entry) =>
    entry !== null && typeof entry === "object" &&
    typeof entry.id === "string" && entry.id !== "reverse" &&
    typeof entry.from === "number" && Number.isFinite(entry.from) &&
    typeof entry.to === "number" && Number.isFinite(entry.to) &&
    typeof entry.answer === "string")) return null;
  return value;
}

// Legacy documents start with their existing positional ids. Once persisted,
// these ids follow the cloze instead of its index in the paragraph.
export function clozeIdsOf(node: Node, syntax = parseBlock(node)): ClozeId[] {
  return validatedClozeIds(node.attrs.clozeIds) ?? syntax.clozes.map(({ inner }, index) => ({
    ...inner, id: `c${index + 1}`, answer: node.cut(inner.from, inner.to).textContent,
  }));
}

// The card each of a block's parsed cards is stored as, with a cloze's answer;
// null where a cloze's metadata lags a text edit until the repair transaction.
function blockCardIds(node: Node, blockId: string, syntax: BlockSyntax) {
  const clozeIds = clozeIdsOf(node, syntax);
  return syntax.cards.map((card, index) => {
    if (card.kind !== "cloze") return {
      id: basicCardId(blockId, index !== 0),
      answer: syntax.cards.length === 2 ? (index === 0 ? "Forward" : "Reverse") : null,
    };
    if (node.type.spec.code) return { id: clozeCardId(blockId, MATH_CLOZE_ID), answer: node.textContent.trim() };
    const inner = syntax.clozes[index]?.inner;
    const entry = inner && clozeIds.find((entry) =>
      entry.from >= 0 && entry.from === inner.from && entry.to === inner.to);
    return entry ? { id: clozeCardId(blockId, entry.id), answer: entry.answer } : null;
  });
}

function cardsOfBlock(node: Node, blockId: string) {
  const syntax = parseBlock(node);
  const ids = blockCardIds(node, blockId, syntax);
  const groups = validatedClozeGroups(node.attrs.clozeGroups);
  const consumed = new Set<number>();
  return syntax.cards.flatMap((card, index) => {
    const entry = ids[index];
    if (!entry || consumed.has(index)) return [];
    const parsed = parseCardId(entry.id);
    const localId = parsed.kind === "cloze" ? parsed.clozeId : null;
    const group = card.kind === "cloze" ? groups.find((members) => localId !== null && members.includes(localId)) : undefined;
    const targets = group ? ids.flatMap((member, i) => member && group.some(id => member.id === clozeCardId(blockId, id)) ? [i] : []) : [index];
    targets.forEach((i) => consumed.add(i));
    // The first member selected for joining owns the combined schedule.
    const owner = group ? targets.find((i) => ids[i]?.id === clozeCardId(blockId, group[0])) : undefined;
    const identity = ids[typeof owner === "number" ? owner : index]!;
    return [{
      ...card, id: identity.id, blockId, targets,
      answer: targets.map((i) => ids[i]?.answer).filter((answer) => answer !== null).join(", ") || null,
      ...(targets.length > 1 ? {
        front: clozeSide(node, syntax, targets, false),
        back: clozeSide(node, syntax, targets, true),
      } : {}),
    }];
  });
}

// The cards stored for a block, as `extractCards` names them.
// A cloze card's answers, or null for other cards.
function answerParts(back: CardPayload): Segment[] | null {
  if (!Array.isArray(back)) return null;
  const answers = back.flatMap((segment) => segment.type === "block" ? segment.children : [segment])
    .flatMap((segment) => segment.type === "cloze" ? [segment.children] : []);
  if (!answers.length) return null;
  return answers.flatMap((children, index) => index ? [{ type: "text" as const, text: ", " }, ...children] : children);
}

// `parts` is a cloze card's answer as it renders, formulas included.
export function cardIdsOf(node: Node): { id: string; answer: string | null; parts?: Segment[] }[] {
  const blockId = node.attrs.cardId;
  if (!isCardBlock(node) || typeof blockId !== "string") return [];
  return cardsOfBlock(node, blockId).map(({ id, answer, back }) => {
    const parts = answerParts(back);
    return parts ? { id, answer, parts } : { id, answer };
  });
}

// Note ids come from documents and pasted HTML, not just us.
export function validatedClozeNote(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// `block` marks a foldable block that is a note as a whole.
export type ClozeNote = Range & { id: string; block?: boolean };

// Each cloze note spans from its first member block to its last, so blocks
// added in between belong to it. A note ends at the next heading, and notes
// never overlap: a note that would overlap an earlier one is ignored.
export function clozeNotesOf(doc: Node): ClozeNote[] {
  const spans = new Map<string, ClozeNote>();
  const ended = new Set<string>();
  doc.descendants((node, pos) => {
    // A foldable block that is a note holds all of its content.
    if (node.type.name === "details") {
      const id = validatedClozeNote(node.attrs.clozeNote);
      if (!id || spans.has(id)) return true;
      spans.set(id, { id, from: pos, to: pos + node.nodeSize, block: true });
      ended.add(id);
      return false;
    }
    if (!node.isTextblock) return true;
    if (node.type.name === "heading") spans.forEach((_, id) => ended.add(id));
    const id = validatedClozeNote(node.attrs.clozeNote);
    if (id && !ended.has(id)) {
      const span = spans.get(id);
      if (span) span.to = pos + node.nodeSize;
      else spans.set(id, { id, from: pos, to: pos + node.nodeSize });
    }
    return false;
  });
  let end = -1;
  return [...spans.values()].filter((note) => {
    if (note.from < end) return false;
    end = note.to;
    return true;
  });
}

// The list depth of a textblock, and its marker when it opens a list item.
function listPlace(doc: Node, pos: number): { depth?: number; marker?: "bullet" | number } {
  const $pos = doc.resolve(pos);
  let depth = 0;
  let marker: "bullet" | number | undefined;
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (!node.type.name.endsWith("Item")) continue;
    depth++;
    if (depth === 1 && $pos.index(d) === 0) {
      const list = $pos.node(d - 1);
      marker = list.type.name === "orderedList" ? (Number(list.attrs.start) || 1) + $pos.index(d - 1) : "bullet";
    }
  }
  return { ...(depth ? { depth } : {}), ...(marker !== undefined ? { marker } : {}) };
}

// One side of a cloze card in a note: every block of the note, with the
// card's own clozes asked and the note's other clozes handled as in a block.
function noteSide(doc: Node, note: ClozeNote, cardPos: number, targets: number[], reveal: boolean): Segment[] {
  const blocks: Segment[] = [];
  doc.nodesBetween(note.from, note.to, (node, pos) => {
    if (!node.isTextblock) return true;
    let children: Segment[];
    if (node.type.name === "mathBlock") {
      const math = displayMath(node);
      children = node.attrs.cloze !== true || !math.length ? math
        : pos === cardPos ? [reveal ? { type: "cloze", children: math } : { type: "blank" }]
        : [reveal ? math[0] : { type: "hidden", children: math }];
    } else if (node.type.spec.code) {
      children = node.textContent ? [{ type: "text", text: node.textContent, marks: ["code"] }] : [];
    } else {
      const syntax = isCardBlock(node) ? parseBlock(node) : null;
      children = syntax?.clozes.length
        ? clozeSide(node, syntax, pos === cardPos ? targets : [], reveal)
        : segmentsOf(unitsOf(node));
    }
    if (children.length) blocks.push({ type: "block", children, ...listPlace(doc, pos) });
    return false;
  });
  return blocks;
}

export type CardGroup = Range & {
  node: Node; kind: "list" | "block"; marker: Range;
  closer: number | null; answers: { node: Node; pos: number }[];
  steps: Segment[][]; valid: boolean; hint: string;
};

// Delimiters are real editable text. Only document siblings participate in v1.
export function groupOpener(node: Node) {
  if (!["paragraph", "heading"].includes(node.type.name)) return null;
  const units = unitsOf(node);
  const text = units.map(u => u.type === "char" ? u.char : "\n").join("");
  const match = /\s(::list|::block)$/.exec(text);
  if (!match) return null;
  const marker = units.slice(-match[1].length);
  if (marker.some(u => u.type !== "char" || !u.syntax)) return null;
  const from = marker[0].at;
  return { kind: match[1] === "::list" ? "list" as const : "block" as const, from, to: node.content.size };
}

export function cardGroupsOf(doc: Node): CardGroup[] {
  const blocks: { node: Node; pos: number }[] = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const groups: CardGroup[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const { node, pos } = blocks[i];
    const opener = groupOpener(node);
    if (!opener) continue;
    let end = i + 1;
    while (end < blocks.length && !(blocks[end].node.type.name === "paragraph" && blocks[end].node.textContent === "::end" && unitsOf(blocks[end].node).every(u => u.type === "char" && u.syntax))) end++;
    const closer = end < blocks.length ? blocks[end].pos : null;
    const answers = blocks.slice(i + 1, end);
    const supported = (n: Node): boolean => ["paragraph", "heading", "mathBlock"].includes(n.type.name) || ["bulletList", "orderedList", "listItem"].includes(n.type.name) && Array.from({ length: n.childCount }, (_, j) => n.child(j)).every(supported);
    const faces = (n: Node, at: number): Segment[] => {
      const face: Segment[] = [];
      const add = (child: Node, position: number) => {
        if (!child.isTextblock) return true;
        face.push({ type: "block", children: child.type.name === "mathBlock" ? displayMath(child) : segmentsOf(unitsOf(child)), ...listPlace(doc, position) });
        return false;
      };
      if (n.isTextblock) add(n, at); else n.descendants((child, offset) => add(child, at + 1 + offset));
      return face;
    };
    const list = answers.length === 1 && ["bulletList", "orderedList"].includes(answers[0].node.type.name) ? answers[0] : null;
    const steps: Segment[][] = [];
    if (opener.kind === "list" && list) list.node.forEach((item, offset) => steps.push(faces(item, list.pos + 1 + offset)));
    else if (opener.kind === "block") steps.push(answers.flatMap(({ node, pos }) => faces(node, pos)));
    const content = opener.kind === "list" ? list !== null && steps.length > 0 && Array.from({length: list.node.childCount}, (_, j) => list.node.child(j).textContent.trim()).every(Boolean) : answers.some(b => b.node.textContent.trim());
    const valid = closer !== null && !!node.textContent.slice(0, opener.from).trim() && !!content && answers.every(b => supported(b.node) && !groupOpener(b.node)) && !node.attrs.clozeNote;
    groups.push({ node, kind: opener.kind, from: pos, to: closer === null ? (answers[answers.length - 1]?.pos ?? pos) + (answers[answers.length - 1]?.node.nodeSize ?? node.nodeSize) : closer + blocks[end].node.nodeSize, marker: { from: pos + 1 + opener.from, to: pos + 1 + opener.to }, closer, answers, steps, valid, hint: closer === null ? "Finish with ::end" : !node.textContent.slice(0, opener.from).trim() ? "Add a question" : opener.kind === "list" ? "Add a list item" : "Add an answer" });
    // Suppress nested syntax only inside complete groups.
    if (closer !== null) i = end;
  }
  return groups;
}

export function extractCards(doc: Node): ExtractedCard[] {
  const cards: ExtractedCard[] = [];
  const seen = new Set<string>();
  const notes = clozeNotesOf(doc);
  const headings = outline(doc);
  const groups = cardGroupsOf(doc);
  let headingIndex = -1;
  doc.descendants((node, pos) => {
    while (headings[headingIndex + 1]?.pos <= pos) headingIndex++;
    // A heading card belongs to its ancestors; inline content belongs to the
    // heading itself, just like subsequent blocks in its section.
    const heading = headings[headingIndex];
    const containing = !heading ? [] : heading.pos === pos
      ? heading.ancestors : [...heading.ancestors, heading];
    const section = containing.map(({ title }) => title);
    const group = groups.find(g => pos >= g.from && pos < g.to);
    if (group) {
      if (pos === group.from && group.valid && typeof node.attrs.cardId === "string" && !seen.has(node.attrs.cardId)) {
        seen.add(node.attrs.cardId);
        cards.push({ id: node.attrs.cardId, blockId: node.attrs.cardId, kind: group.kind === "list" ? "list" : "basic", front: segmentsOf(trim(unitsOf(node).filter(u => u.at < group.marker.from - pos - 1))), back: group.kind === "list" ? group.steps.map(children => ({ type: "block" as const, children, revealStep: true as const })) : group.steps[0], section });
      }
      return false;
    }
    if (isImageNode(node)) {
      const { imageId, fileId } = node.attrs;
      if (typeof imageId === "string" && typeof fileId === "string" && !seen.has(imageId)) {
        seen.add(imageId);
        const masks = validMasks(node.attrs.masks);
        for (const { owner, members } of maskCards(masks)) {
          const front: OcclusionFace = { version: 1, fileId, imageId, targetMaskId: owner.id, targetMaskIds: members.map(m => m.id), revealed: false, masks };
          cards.push({ id: occlusionCardId(imageId, owner.id), blockId: imageId, kind: "occlusion", front, back: { ...front, revealed: true }, section });
        }
      }
      return false;
    }
    // Inline images can live inside a text card block.
    if (!node.isTextblock) return true;
    const blockId = node.attrs.cardId;
    if (!isCardBlock(node) || typeof blockId !== "string" || seen.has(blockId)) return true;
    seen.add(blockId);
    const note = notes.find(({ from, to }) => pos >= from && pos < to);
    cards.push(...cardsOfBlock(node, blockId).map(({ targets, ...card }) => note && card.kind === "cloze"
      ? { ...card, section, front: noteSide(doc, note, pos, targets, false), back: noteSide(doc, note, pos, targets, true) }
      : { ...card, section }));
    return true;
  });
  return cards;
}

// The ranges of the final document touched by a series of step maps.
export function changedRanges(maps: readonly StepMap[]): Range[] {
  const ranges: Range[] = [];
  maps.forEach((map, index) => {
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      let from = newFrom;
      let to = newTo;
      for (const later of maps.slice(index + 1)) {
        from = later.map(from, -1);
        to = later.map(to, 1);
      }
      ranges.push({ from, to: Math.max(from, to) });
    });
  });
  return ranges;
}

// Which blocks need a new card id, or lose a copied one. Blocks outside the
// changed ranges keep their ids, so a pasted copy is the one renumbered. In a
// changed range, a block with card syntax claims an id before one without (a
// paragraph split at its start leaves the card text in the second half), and
// a duplicate id on a block without syntax is simply dropped.
export function planCardIds(
  doc: Node,
  changed: Range[],
  newId: () => string,
): { pos: number; cardId: string | null }[] {
  type Block = { pos: number; node: Node; id: string | null };
  const kept = new Set<string>();
  const touched: Block[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!isCardBlock(node)) return false;
    const id = typeof node.attrs.cardId === "string" ? node.attrs.cardId : null;
    const end = pos + node.nodeSize;
    if (changed.some((range) => range.from < end && range.to > pos)) {
      touched.push({ pos, node, id });
    } else if (id) {
      kept.add(id);
    }
    return false;
  });

  const plan: { pos: number; cardId: string | null }[] = [];
  const withCards = touched.filter((block) => parseBlock(block.node).cards.length > 0 || groupOpener(block.node) !== null);
  for (const block of withCards) {
    if (block.id && !kept.has(block.id)) {
      kept.add(block.id);
    } else {
      plan.push({ pos: block.pos, cardId: newId() });
    }
  }
  for (const block of touched) {
    if (!withCards.includes(block) && block.id && kept.has(block.id)) {
      plan.push({ pos: block.pos, cardId: null });
    }
  }
  return plan;
}
