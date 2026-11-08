import { highlightColor } from "./highlight.ts";
import { maskCards, validMasks, type OcclusionFace } from "./occlusion.ts";
import type { Node } from "@tiptap/pm/model";
import type { StepMap } from "@tiptap/pm/transform";

// Flashcards written in note text. A paragraph or heading is a card block:
//   - Basic: `Question :: Answer`. The first `::` with no text character
//     directly on either side splits the block, so `std::vector` stays prose.
//   - Two-way: `Front ::: Back` makes forward and reverse basic cards.
//     Exactly two or three colons match; four colons stay prose.
//   - Cloze: `{{hidden}}`. Each cloze is its own card; the review shows the
//     whole block with that cloze hidden and the other clozes as plain text.
//   - A block with a cloze is a cloze block; any `::` or `:::` in it is plain text.
// Text in inline code is never syntax. Inline math may appear on either side
// and inside a cloze. A card needs a non-empty front and answer.

// The review renderer switches on kind. Image occlusion adds "occlusion".
export type CardKind = "basic" | "cloze" | "occlusion";

export type Segment =
  | { type: "text"; text: string; marks?: string[]; highlightColor?: string }
  | { type: "math"; tex: string; highlightColor?: string }
  | { type: "break" }
  // The answer of a cloze card, highlighted on the back.
  | { type: "cloze"; children: Segment[] }
  // The hidden cloze on the front.
  | { type: "blank" }
  // Another cloze of the block, also hidden on the front; review can show it
  // on its own, for context.
  | { type: "hidden"; children: Segment[] };

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

export function parseBlock(block: Node): BlockSyntax {
  const units = unitsOf(block);
  const syntax: BlockSyntax = { separator: null, clozes: [], cards: [] };

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
function isCardBlock(node: Node) {
  return node.isTextblock && !node.type.spec.code && "cardId" in node.attrs;
}

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
      id: index === 0 ? blockId : `${blockId}:reverse`,
      answer: syntax.cards.length === 2 ? (index === 0 ? "Forward" : "Reverse") : null,
    };
    const inner = syntax.clozes[index]?.inner;
    const entry = inner && clozeIds.find((entry) =>
      entry.from >= 0 && entry.from === inner.from && entry.to === inner.to);
    return entry ? { id: `${blockId}:${entry.id}`, answer: entry.answer } : null;
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
    const localId = entry.id.slice(blockId.length + 1);
    const group = card.kind === "cloze" ? groups.find((members) => members.includes(localId)) : undefined;
    const targets = group ? ids.flatMap((member, i) => member && group.includes(member.id.slice(blockId.length + 1)) ? [i] : []) : [index];
    targets.forEach((i) => consumed.add(i));
    // The first member selected for joining owns the combined schedule.
    const owner = group ? targets.find((i) => ids[i]?.id === `${blockId}:${group[0]}`) : undefined;
    const identity = ids[typeof owner === "number" ? owner : index]!;
    return [{
      ...card, id: identity.id, blockId,
      answer: targets.map((i) => ids[i]?.answer).filter((answer) => answer !== null).join(", ") || null,
      ...(targets.length > 1 ? {
        front: clozeSide(node, syntax, targets, false),
        back: clozeSide(node, syntax, targets, true),
      } : {}),
    }];
  });
}

// The cards stored for a block, as `extractCards` names them.
export function cardIdsOf(node: Node): { id: string; answer: string | null }[] {
  const blockId = node.attrs.cardId;
  if (!isCardBlock(node) || typeof blockId !== "string") return [];
  return cardsOfBlock(node, blockId).map(({ id, answer }) => ({ id, answer }));
}

export function extractCards(doc: Node): ExtractedCard[] {
  const cards: ExtractedCard[] = [];
  const seen = new Set<string>();
  // The open headings above the current block, as in the section breadcrumb.
  const headings: { level: number; title: string }[] = [];
  doc.descendants((node, _pos, parent) => {
    const isHeading = parent === doc && node.type.name === "heading";
    const level = Number(node.attrs.level);
    if (isHeading) {
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
    }
    const section = headings.map(({ title }) => title);
    if (["image", "inlineImage"].includes(node.type.name)) {
      const { imageId, fileId } = node.attrs;
      if (typeof imageId === "string" && typeof fileId === "string" && !seen.has(imageId)) {
        seen.add(imageId);
        const masks = validMasks(node.attrs.masks);
        for (const { owner, members } of maskCards(masks)) {
          const front: OcclusionFace = { version: 1, fileId, imageId, targetMaskId: owner.id, targetMaskIds: members.map(m => m.id), revealed: false, masks };
          cards.push({ id: `${imageId}:o:${owner.id}`, blockId: imageId, kind: "occlusion", front, back: { ...front, revealed: true }, section });
        }
      }
      return false;
    }
    // Inline images can live inside a text card block.
    if (!node.isTextblock) return true;
    const blockId = node.attrs.cardId;
    // A heading that is itself a card belongs to the headings above it.
    if (isHeading) headings.push({ level, title: node.textContent.trim() || "Untitled section" });
    if (!isCardBlock(node) || typeof blockId !== "string" || seen.has(blockId)) return true;
    seen.add(blockId);
    cards.push(...cardsOfBlock(node, blockId).map((card) => ({ ...card, section })));
    return true;
  });
  return cards;
}

export function blockIdOf(cardId: string) {
  return cardId.replace(/:o:.*$|:reverse$|:c[^:]+$/, "");
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
  const withCards = touched.filter((block) => parseBlock(block.node).cards.length > 0);
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
