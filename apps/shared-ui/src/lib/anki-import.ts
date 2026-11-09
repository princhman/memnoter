import { occlusionCardId } from "./card-id.ts";
import type { AnkiLabel } from "./anki-labels.ts";
import type { JSONContent } from "@tiptap/core";
import { clozeToHtml, defuse, hasContent, htmlToLines, joinLines, type AnkiImageRef } from "./anki-html.ts";
import { imageMime } from "./folder-import.ts";
import { maskCards, validMasks, type Mask } from "./occlusion.ts";

// The contract with `memnoter-core`'s anki module: decks and notes as Anki
// stores them, field values being Anki's HTML.
export type AnkiCard = { ord: number; mask?: string; kind: "new" | "learning" | "review" | "relearning"; suspended: boolean; due?: number; intervalDays: number; ease: number; reps: number; lapses: number; reviews: { time: number; rating: number }[] };
export type CardMapping = { cardId: string; anki: AnkiCard };
export type AnkiDeck = { id: number; name: string; cardCount: number };
export type AnkiContent =
  | { kind: "basic"; front: string; back: string; extra: string; reversed: boolean }
  | { kind: "cloze"; text: string; extra: string }
  | { kind: "occlusion"; image: string; masks: Mask[]; labels?: AnkiLabel[]; header: string; extra: string }
  | { kind: "unsupported"; notetype: string };
export type AnkiItem = { noteId: number; deckId: number; notetype: string; cards?: AnkiCard[] } & AnkiContent;
export type AnkiPackage = { decks: AnkiDeck[]; items: AnkiItem[]; media: string[]; warnings: string[] };

/** What a deck becomes: a module, a heading in its module, part of its parent's section, or nothing. */
export type DeckRole = "module" | "heading" | "merge" | "skip";
export type AnkiSelection = {
  roles: Record<string, DeckRole>;
  /** Module names; a deck's own name by default. */
  names?: Record<string, string>;
  /** The sidebar folder of each module, by deck; none by default. */
  folders?: Record<string, string | null>;
};

export type DeckNode = {
  /** The full deck name, which identifies the deck in a selection. */
  key: string;
  name: string;
  depth: number;
  /** Cards directly in this deck, and in it and its subdecks. */
  own: number;
  total: number;
  children: DeckNode[];
};

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function deckTree(decks: AnkiDeck[]): DeckNode[] {
  const nodes = new Map<string, DeckNode>();
  const roots: DeckNode[] = [];
  const ensure = (path: string[]): DeckNode => {
    const key = path.join("::");
    let node = nodes.get(key);
    if (!node) {
      node = { key, name: path[path.length - 1], depth: path.length, own: 0, total: 0, children: [] };
      nodes.set(key, node);
      if (path.length > 1) ensure(path.slice(0, -1)).children.push(node);
      else roots.push(node);
    }
    return node;
  };
  for (const deck of decks) {
    const path = deck.name.split("::");
    ensure(path).own += deck.cardCount;
    for (let end = 1; end <= path.length; end++) ensure(path.slice(0, end)).total += deck.cardCount;
  }
  const sort = (list: DeckNode[]) => { list.sort((a, b) => natural.compare(a.name, b.name)); list.forEach(node => sort(node.children)); };
  sort(roots);
  return roots;
}

const walk = (nodes: DeckNode[]): DeckNode[] => nodes.flatMap(node => [node, ...walk(node.children)]);

/**
 * Modules sit at the level where the deck tree first branches into several
 * non-empty decks (a course folder holding several courses); a deck with cards
 * above that level is a module of its own. Everything below a module becomes
 * headings, and the deck above a module names its folder.
 */
export function defaultSelection(decks: AnkiDeck[]): AnkiSelection {
  const roots = deckTree(decks);
  const nodes = walk(roots).filter(node => node.total > 0);
  const roles: Record<string, DeckRole> = {};
  const folders: Record<string, string | null> = {};
  for (const node of walk(roots)) roles[node.key] = "skip";
  const branching = [...new Set(nodes.map(node => node.depth))].sort((a, b) => a - b).find(depth => nodes.filter(node => node.depth === depth).length > 1);
  const level = branching ?? Math.min(...nodes.filter(node => node.own > 0).map(node => node.depth), Infinity);
  if (!Number.isFinite(level)) return { roles, folders };
  const assign = (node: DeckNode, parent: DeckNode | undefined, inModule: boolean) => {
    if (node.total === 0) return;
    const module = !inModule && (node.depth === level || (node.depth < level && node.own > 0));
    if (module) { roles[node.key] = "module"; folders[node.key] = parent?.name ?? null; }
    else if (inModule) roles[node.key] = "heading";
    for (const child of node.children) assign(child, node, inModule || module);
  };
  for (const root of roots) assign(root, undefined, false);
  return { roles, folders };
}

export type PlannedModule = {
  key: string;
  name: string;
  folder: string | null;
  document: JSONContent;
  cards: number;
  histories: CardMapping[];
};
export type AnkiImportPlan = {
  modules: PlannedModule[];
  /** Media files the documents refer to; each is stored once. */
  images: string[];
  notes: number;
  cards: number;
  warnings: string[];
  labels: Record<string, AnkiLabel[]>;
};

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (content: JSONContent[]): JSONContent => ({ type: "paragraph", attrs: { cardId: crypto.randomUUID() }, ...(content.length ? { content } : {}) });
const heading = (title: string, level: number): JSONContent => ({ type: "heading", attrs: { level: Math.min(6, level) }, content: [text(title)] });

type Context = { media: Set<string>; images: Set<string>; warnings: Map<string, number>; labels: Record<string, AnkiLabel[]> };
const warn = (context: Context, message: string) => context.warnings.set(message, (context.warnings.get(message) ?? 0) + 1);

function mediaName(context: Context, src: string): string | undefined {
  const candidates = [src];
  try { candidates.push(decodeURIComponent(src)); } catch { /* keep literal */ }
  return candidates.find(name => context.media.has(name));
}

function imageBlock(context: Context, name: string, masks: Mask[] = []): JSONContent {
  context.images.add(name);
  return { type: "image", attrs: { fileId: name, imageId: crypto.randomUUID(), src: null, alt: "", width: null, masks } };
}

/** Images found in a card's text, placed after the card since a card holds only text. */
function imagesAfter(context: Context, refs: AnkiImageRef[]): JSONContent[] {
  const blocks: JSONContent[] = [];
  for (const { src } of refs) {
    if (/^(?:https?:|data:)/i.test(src)) { warn(context, "An image from the web couldn't be imported."); continue; }
    const name = mediaName(context, src);
    if (!name) { warn(context, "An image the notes refer to is missing from the package."); continue; }
    if (!imageMime(name)) { warn(context, `Images in ${name.split(".").pop()?.toUpperCase()} format can't be imported.`); continue; }
    blocks.push(imageBlock(context, name));
  }
  return blocks;
}

const IMAGE_ONLY = "(image)";

type Blocks = { blocks: JSONContent[]; cards: number; owners?: { n: number; id: string }[] };

function basicBlocks(context: Context, item: Extract<AnkiItem, { kind: "basic" }>): Blocks {
  const front = htmlToLines(item.front);
  const back = htmlToLines(item.back);
  const extra = htmlToLines(item.extra);
  if (hasContent(extra.lines)) { back.lines.push([], ...extra.lines); back.images.push(...extra.images); }
  const side = (inline: ReturnType<typeof htmlToLines>) => hasContent(inline.lines) ? joinLines(inline.lines) : inline.images.length ? [text(IMAGE_ONLY)] : undefined;
  const question = side(front), answer = side(back);
  if (!question || !answer) { warn(context, "A card with an empty front or back was skipped."); return { blocks: [], cards: 0 }; }
  const cardImages = [...front.images, ...back.images];
  if (cardImages.length) warn(context, "Images inside cards are placed below the card.");
  return {
    blocks: [
      paragraph([...defuse(question, { clozes: true, separators: true }), text(item.reversed ? " ::: " : " :: "), ...defuse(answer, { clozes: true, separators: false })]),
      ...imagesAfter(context, cardImages),
    ],
    cards: item.reversed ? 2 : 1,
  };
}

function clozeBlocks(context: Context, item: Extract<AnkiItem, { kind: "cloze" }>): Blocks {
  const body = htmlToLines(clozeToHtml(item.text));
  const joined = joinLines(body.lines);
  const clozes = joined.filter(node => node.type === "text" && !node.marks?.some(mark => mark.type === "code")).map(node => node.text).join("\u0000").match(/\{\{[\s\S]+?\}\}/g)?.length ?? 0;
  if (!hasContent(body.lines)) { warn(context, "A card with no text was skipped."); return { blocks: [], cards: 0 }; }
  if (!clozes) warn(context, "Some cloze notes have no blanks that could be read; they were imported as plain text.");
  const extra = htmlToLines(item.extra);
  if (body.images.length) warn(context, "Images inside cards are placed below the card.");
  // Blanks with no text (an image only) vanish in conversion; skip their numbers so histories stay aligned.
  const numbers = [...item.text.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::[^{}<>]*?)?\}\}/g)].filter(m => hasContent(htmlToLines(m[2]).lines)).map(m => Number(m[1]));
  const groups = new Map<number, string[]>();
  numbers.slice(0, clozes).forEach((n, index) => groups.set(n, [...groups.get(n) ?? [], `c${index + 1}`]));
  const block = paragraph(joined);
  block.attrs = { ...block.attrs, clozeGroups: [...groups.values()].filter(g => g.length > 1) };
  const owners = [...groups].map(([n, ids]) => ({ n, id: ids[0] }));
  return {
    owners,
    blocks: [
      block,
      ...imagesAfter(context, [...body.images, ...extra.images]),
      ...(hasContent(extra.lines) ? [paragraph(defuse(joinLines(extra.lines)))] : []),
    ],
    cards: groups.size,
  };
}

function occlusionBlocks(context: Context, item: Extract<AnkiItem, { kind: "occlusion" }>): Blocks {
  const masks = validMasks(item.masks);
  if (!context.media.has(item.image)) { warn(context, "An image with hidden regions is missing from the package."); return { blocks: [], cards: 0 }; }
  if (!imageMime(item.image) || !masks.length) { warn(context, "An image with hidden regions couldn't be imported."); return { blocks: [], cards: 0 }; }
  if (item.labels?.length) context.labels[item.image + "#" + item.noteId] = item.labels;
  const image = imageBlock(context, item.image, masks);
  if (item.labels?.length) image.attrs = { ...image.attrs, fileId: item.image + "#" + item.noteId };
  const header = htmlToLines(item.header);
  const extra = htmlToLines(item.extra);
  return {
    blocks: [
      ...(hasContent(header.lines) ? [paragraph(defuse(joinLines(header.lines)))] : []),
      image,
      ...(hasContent(extra.lines) ? [paragraph(defuse(joinLines(extra.lines)))] : []),
    ],
    cards: maskCards(masks).length,
  };
}

/** Builds the module documents for the chosen decks; nothing is stored. */
export function prepareAnkiImport(pkg: AnkiPackage, selection: AnkiSelection): AnkiImportPlan {
  const roots = deckTree(pkg.decks);
  const idToKey = new Map(pkg.decks.map(deck => [deck.id, deck.name]));
  const itemsByDeck = new Map<string, AnkiItem[]>();
  for (const item of pkg.items) {
    const key = idToKey.get(item.deckId);
    if (key !== undefined) itemsByDeck.set(key, [...itemsByDeck.get(key) ?? [], item]);
  }
  const context: Context = { media: new Set(pkg.media), images: new Set(), warnings: new Map(), labels: {} };
  const role = (node: DeckNode): DeckRole => selection.roles[node.key] ?? "skip";
  let notes = 0, cards = 0;
  function section(node: DeckNode, level: number): { blocks: JSONContent[]; cards: number; histories: CardMapping[] } {
    const blocks: JSONContent[] = [];
    let count = 0;
    const histories: CardMapping[] = [];
    for (const item of itemsByDeck.get(node.key) ?? []) {
      if (item.kind === "unsupported") continue;
      const made = item.kind === "basic" ? basicBlocks(context, item) : item.kind === "cloze" ? clozeBlocks(context, item) : occlusionBlocks(context, item);
      if (made.cards) notes++;
      for (const anki of item.cards ?? []) {
        let cardId: string | undefined;
        if (item.kind === "basic" && made.cards) cardId = made.blocks[0].attrs?.cardId + (anki.ord === 1 ? ":reverse" : "");
        if (item.kind === "cloze" && "owners" in made) {
          const owner = made.owners?.find(o => o.n === anki.ord + 1);
          if (owner) cardId = made.blocks[0].attrs?.cardId + ":" + owner.id;
        }
        if (item.kind === "occlusion") {
          const image = made.blocks.find(b => b.type === "image");
          const group = maskCards(validMasks(item.masks)).find(g => g.members.some(m => m.id === anki.mask));
          if (image && group) cardId = occlusionCardId(image.attrs?.imageId, group.owner.id);
        }
        if (cardId) histories.push({ cardId, anki });
      }
      blocks.push(...made.blocks);
      count += made.cards;
    }
    for (const child of node.children) {
      if (role(child) === "heading") {
        const inner = section(child, level + 1);
        blocks.push(heading(child.name, level + 1), ...inner.blocks);
        count += inner.cards;
        histories.push(...inner.histories);
      } else if (role(child) === "merge") {
        const inner = section(child, level);
        blocks.push(...inner.blocks);
        count += inner.cards;
        histories.push(...inner.histories);
      }
    }
    return { blocks, cards: count, histories };
  }
  const modules: PlannedModule[] = [];
  for (const node of walk(roots)) {
    if (role(node) !== "module") continue;
    const built = section(node, 0);
    if (!built.cards) { warn(context, `${node.name} has no cards that could be imported, so it was left out.`); continue; }
    cards += built.cards;
    modules.push({
      key: node.key,
      name: selection.names?.[node.key]?.trim() || node.name,
      folder: selection.folders?.[node.key]?.trim() || null,
      document: { type: "doc", content: built.blocks },
      cards: built.cards,
      histories: built.histories,
    });
  }
  const suspended = modules.flatMap(m => m.histories).filter(h => h.anki.suspended).length;
  const warnings = [
    ...(suspended ? [`${suspended} suspended cards were imported as new`] : []),
    ...pkg.warnings,
    ...[...context.warnings].map(([message, count]) => count > 1 ? `${message} (${count})` : message),
  ];
  return { modules, images: [...context.images], notes, cards, warnings, labels: context.labels };
}
