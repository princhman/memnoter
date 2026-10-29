import type { Node } from "@tiptap/pm/model";
import type { StepMap } from "@tiptap/pm/transform";

// Flashcards written in note text. A paragraph or heading is a card block:
//   - Basic: `Question :: Answer`. The first `::` with no text character
//     directly on either side splits the block, so `std::vector` stays prose.
//   - Cloze: `{{hidden}}`. Each cloze is its own card; the review shows the
//     whole block with that cloze hidden and the other clozes as plain text.
//   - A block with a cloze is a cloze block; any `::` in it is plain text.
// Text in inline code is never syntax. Inline math may appear on either side
// and inside a cloze. A card needs a non-empty front and answer.

// The review renderer switches on kind. Image occlusion adds "occlusion".
export type CardKind = "basic" | "cloze" | "occlusion";

export type Segment =
  | { type: "text"; text: string; marks?: string[] }
  | { type: "math"; tex: string }
  | { type: "break" }
  // The answer of a cloze card, highlighted on the back.
  | { type: "cloze"; children: Segment[] }
  // The hidden cloze on the front.
  | { type: "blank" };

export type ExtractedCard = {
  // `<cardId>` for basic cards, `<cardId>:<stable cloze id>` for clozes.
  id: string;
  blockId: string;
  kind: CardKind;
  front: Segment[];
  back: Segment[];
};

// Offsets are relative to the start of the block's content.
export type Range = { from: number; to: number };
export type ClozeId = Range & { id: string; answer: string };

export type BlockSyntax = {
  separator: Range | null;
  clozes: { open: Range; inner: Range; close: Range }[];
  // The cards this block yields once it has an id, without ids.
  cards: Omit<ExtractedCard, "id" | "blockId">[];
};

type Unit =
  | { type: "char"; char: string; marks: string[]; syntax: boolean; at: number }
  | { type: "math"; tex: string; at: number; size: number }
  | { type: "break"; at: number };

const KEPT_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "highlight"]);

function unitsOf(block: Node): Unit[] {
  const units: Unit[] = [];
  block.forEach((child, offset) => {
    if (child.isText) {
      const marks = child.marks.map((mark) => mark.type.name).filter((name) => KEPT_MARKS.has(name));
      const syntax = !child.marks.some((mark) => mark.type.spec.code || mark.type.name === "link");
      // Iterate code points so surrogate pairs stay whole; positions count
      // UTF-16 units, as ProseMirror does.
      let at = offset;
      for (const char of child.text!) {
        units.push({ type: "char", char, marks, syntax, at });
        at += char.length;
      }
    } else if (child.type.name === "inlineMath") {
      units.push({
        type: "math",
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
    if (unit.type === "math") segments.push({ type: "math", tex: unit.tex });
    else if (unit.type === "break") segments.push({ type: "break" });
    else {
      const last = segments[segments.length - 1];
      const marks = unit.marks.length ? unit.marks : undefined;
      if (last?.type === "text" && String(last.marks) === String(marks)) {
        last.text += unit.char;
      } else {
        segments.push(marks ? { type: "text", text: unit.char, marks } : { type: "text", text: unit.char });
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
    // Other clozes in the block read as plain text, without their braces.
    const braces = new Set(clozes.flatMap(({ open, close }) => [open, open + 1, close, close + 1]));
    const side = (target: number, reveal: boolean) => {
      const segments: Segment[] = [];
      let start = 0;
      const flush = (end: number) => {
        segments.push(...segmentsOf(units.slice(start, end).filter((_, i) => !braces.has(start + i))));
      };
      const { open, close } = clozes[target];
      flush(open);
      segments.push(reveal ? { type: "cloze", children: segmentsOf(units.slice(open + 2, close)) } : { type: "blank" });
      start = close + 2;
      flush(units.length);
      return mergeText(segments);
    };
    clozes.forEach((_, index) => {
      syntax.cards.push({ kind: "cloze", front: side(index, false), back: side(index, true) });
    });
    return syntax;
  }

  for (let i = 0; i < units.length - 1; i++) {
    if (
      isSyntax(units[i], ":") &&
      isSyntax(units[i + 1], ":") &&
      !isWordChar(units[i - 1]) &&
      !isWordChar(units[i + 2])
    ) {
      syntax.separator = span(units, i, i + 2);
      const front = trim(units.slice(0, i));
      const back = trim(units.slice(i + 2));
      if (hasContent(front) && hasContent(back)) {
        syntax.cards.push({ kind: "basic", front: segmentsOf(front), back: segmentsOf(back) });
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
      String(last.marks) === String(segment.marks)
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

// Legacy documents start with their existing positional ids. Once persisted,
// these ids follow the cloze instead of its index in the paragraph.
export function clozeIdsOf(node: Node, syntax = parseBlock(node)): ClozeId[] {
  return node.attrs.clozeIds ?? syntax.clozes.map(({ inner }, index) => ({
    ...inner, id: `c${index + 1}`, answer: node.cut(inner.from, inner.to).textContent,
  }));
}

export function extractCards(doc: Node): ExtractedCard[] {
  const cards: ExtractedCard[] = [];
  const seen = new Set<string>();
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    const blockId = node.attrs.cardId;
    if (!isCardBlock(node) || typeof blockId !== "string" || seen.has(blockId)) return false;
    seen.add(blockId);
    const syntax = parseBlock(node);
    const clozeIds = clozeIdsOf(node, syntax);
    syntax.cards.forEach((card, index) => {
      cards.push({
        ...card,
        blockId,
        id: card.kind === "cloze" ? `${blockId}:${clozeIds[index].id}` : blockId,
      });
    });
    return false;
  });
  return cards;
}

export function blockIdOf(cardId: string) {
  return cardId.replace(/:c[^:]+$/, "");
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
