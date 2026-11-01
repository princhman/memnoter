import { Fragment, Slice } from "@tiptap/pm/model";
import { renewImageIdentity } from "./occlusion.ts";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { cardIdsOf, changedRanges, clozeIdsOf, parseBlock, planCardIds, validatedClozeIds, validatedClozeGroups, type ClozeId, type Range } from "./cards.ts";
import { formatInterval } from "./fsrs.ts";

const flashcardIdsKey = new PluginKey<boolean>("flashcardIds");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    flashcards: {
      // Wrap the selection in {{…}}, making it a cloze card.
      makeCloze: () => ReturnType;
      joinClozes: () => ReturnType;
      // Remove the braces of the cloze holding the selection, keeping its text.
      removeCloze: () => ReturnType;
      // Show when the note's cards are due and were last reviewed, as of `now`.
      setCardSchedules: (schedules: CardSchedule[], now: number) => ReturnType;
      // Give these blocks fresh card ids, e.g. when another note owns them.
      renewCardIds: (blockIds: string[]) => ReturnType;
    };
  }
}

export type CardSchedule = {
  id: string;
  dueAt: number;
  lastReviewAt: number | null;
  state: number;
};

type Schedules = { byId: Map<string, CardSchedule>; now: number };

const decorationsKey = new PluginKey<{ set: DecorationSet; schedules: Schedules }>(
  "flashcardDecorations",
);

// A small margin dot with each card's schedule shown on hover.
function cardInfo(
  entries: { answer: string | null; schedule: CardSchedule | undefined }[],
  due: boolean,
  now: number,
  onJoin: (() => void) | null,
) {
  const info = document.createElement("span");
  info.className = "card-info";
  info.contentEditable = "false";
  info.tabIndex = 0;
  info.setAttribute("role", "group");
  info.setAttribute("aria-label", "Card details");
  if (due) info.dataset.due = "";
  // A block may contain several cards; its dot follows the next one due.
  const next = entries.flatMap(({ schedule }) => schedule ? [schedule] : [])
    .reduce<CardSchedule | undefined>((first, card) => !first || card.dueAt < first.dueAt ? card : first, undefined);
  const stateName = (state: number) => state === 0 ? "New" : state === 1 ? "Learning" : state === 3 ? "Relearning" : "Review";
  info.dataset.state = next ? stateName(next.state).toLowerCase() : "unsaved";

  const popup = document.createElement("span");
  popup.className = "card-info-popup";
  popup.setAttribute("role", onJoin ? "dialog" : "tooltip");
  if (onJoin) popup.setAttribute("aria-label", "Card details");
  for (const { answer, schedule } of entries) {
    const row = document.createElement("span");
    row.className = "card-info-row";
    const heading = document.createElement("span");
    heading.className = "card-info-heading";
    const name = document.createElement("span");
    name.className = "card-info-answer";
    name.textContent = answer ?? "Card";
    name.title = answer ?? "Card";
    const badge = document.createElement("span");
    badge.className = "card-info-state";
    badge.dataset.state = schedule ? stateName(schedule.state).toLowerCase() : "unsaved";
    badge.textContent = schedule ? stateName(schedule.state) : "Unsaved";
    heading.append(name, badge);
    row.append(heading);
    const dueText = document.createElement("span");
    dueText.className = "card-info-due";
    dueText.textContent = !schedule ? "Not saved yet" : schedule.dueAt <= now
      ? "Due now" : `Due in ${formatInterval(schedule.dueAt - now)}`;
    row.append(dueText);
    if (schedule) {
      const reviewed = document.createElement("span");
      reviewed.className = "card-info-reviewed";
      reviewed.textContent = schedule.lastReviewAt === null ? "Never reviewed"
        : `Last reviewed ${formatInterval(now - schedule.lastReviewAt)} ago`;
      row.append(reviewed);
    }
    popup.append(row);
  }
  if (onJoin) {
    const join = document.createElement("button");
    join.type = "button";
    join.className = "card-info-join";
    join.textContent = "Join into one card";
    join.addEventListener("mousedown", (event) => event.preventDefault());
    join.addEventListener("click", onJoin);
    const footer = document.createElement("span");
    footer.className = "card-info-footer";
    footer.append(join);
    popup.append(footer);
  }
  info.append(popup);
  return info;
}

// Card syntax stays real, editable text: decorations only restyle it.
// A faint `::` reads as an arrow until the caret enters its block. Cloze
// braces always take no room; their answer text stays highlighted and underlined.
function blockDecorations(node: Node, pos: number, schedules: Schedules): Decoration[] {
  const syntax = parseBlock(node);
  const start = pos + 1;
  const decorations: Decoration[] = [];
  const entries = cardIdsOf(node).map(({ id, answer }) => ({
    answer,
    schedule: schedules.byId.get(id),
  }));
  if (entries.length > 0) {
    const due = entries.some(({ schedule }) => schedule && schedule.dueAt <= schedules.now);
    // Redrawn when what it shows changes.
    const key = JSON.stringify([due, entries.map(({ answer, schedule }) =>
      [answer, schedule?.state ?? null, schedule?.dueAt ?? null, schedule?.lastReviewAt ?? null])]);
    decorations.push(
      Decoration.widget(start, (view, getPos) => cardInfo(entries, due, schedules.now,
        syntax.clozes.length > 1 && entries.length > 1 ? () => {
          // Resolve the widget's current position: edits above it can move it.
          const position = getPos();
          if (position === undefined) return;
          const $pos = view.state.doc.resolve(position);
          const groups = joinedClozeGroups($pos.parent, 0, $pos.parent.content.size);
          if (groups) view.dispatch(view.state.tr.setNodeAttribute($pos.before(), "clozeGroups", groups));
        } : null), {
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `card-info:${schedules.now}:${key}`,
      }),
    );
  }
  if (syntax.cards.length > 0) {
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "card-block",
        "data-card-kind": syntax.cards[0].kind,
      }),
    );
  }
  if (syntax.separator) {
    decorations.push(
      Decoration.inline(start + syntax.separator.from, start + syntax.separator.to, {
        class: "card-sep",
      }, { syntax: true }),
    );
  }
  for (const { open, inner, close } of syntax.clozes) {
    decorations.push(
      Decoration.inline(start + open.from, start + open.to, { class: "cloze-brace" }, { syntax: true }),
      Decoration.inline(start + inner.from, start + inner.to, { class: "cloze-text" }),
      Decoration.inline(start + close.from, start + close.to, { class: "cloze-brace" }, { syntax: true }),
    );
  }
  return decorations;
}

// Shared by the selected-cloze action and the block's dot menu.
function joinedClozeGroups(node: Node, from: number, to: number) {
  const entries = clozeIdsOf(node).filter((entry) => entry.from >= 0 && entry.from < to && entry.to > from);
  const groups = validatedClozeGroups(node.attrs.clozeGroups);
  const owners = new Set(entries.map(({ id }) => groups.find((group) => group.includes(id))?.[0] ?? id));
  if (owners.size < 2) return null;
  const members = [...new Set(entries.flatMap(({ id }) => groups.find((group) => group.includes(id)) ?? [id]))];
  return [...groups.filter((group) => !group.some((id) => members.includes(id))), members];
}

function isCardBlock(node: Node) {
  return node.isTextblock && !node.type.spec.code && "cardId" in node.attrs;
}

// The cloze around the selection, braces included, as document positions.
export function clozeAt(state: EditorState) {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !isCardBlock($from.parent)) return null;
  const start = $from.start();
  const cloze = parseBlock($from.parent).clozes.find(
    ({ open, close }) => start + open.from <= $from.pos && $to.pos <= start + close.to,
  );
  return cloze && {
    open: { from: start + cloze.open.from, to: start + cloze.open.to },
    close: { from: start + cloze.close.from, to: start + cloze.close.to },
  };
}

function collectBlocks(doc: Node, from: number, to: number) {
  const blocks: { node: Node; pos: number }[] = [];
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
    if (!node.isTextblock) return true;
    if (isCardBlock(node)) blocks.push({ node, pos });
    return false;
  });
  return blocks;
}

// Expand at boundaries to include the two sides of joins and splits, and
// deduplicate blocks when several steps touched the same paragraph.
function collectChangedBlocks(doc: Node, ranges: Range[]) {
  const blocks = new Map<number, { node: Node; pos: number }>();
  for (const { from, to } of ranges) {
    for (const block of collectBlocks(doc, from, to)) blocks.set(block.pos, block);
  }
  return [...blocks.values()];
}

// A backward join keeps the first block's attributes. Recover the identity of
// the merged card from a surviving character before assigning any new ids.
function carryMergedCardIds(
  tr: Transaction, oldDoc: Node, mapping: Mapping, oldBlocks: ReturnType<typeof collectBlocks>,
) {
  const ids = new Set(collectBlocks(tr.doc, 0, tr.doc.content.size).map(({ node }) => node.attrs.cardId));
  for (const { node, pos } of oldBlocks) {
    const id = node.attrs.cardId;
    if (!id || ids.has(id) || parseBlock(node).cards.length === 0) continue;
    const mapped = mapping.mapResult(pos + 2);
    if (mapped.deletedAcross) continue;
    const $pos = tr.doc.resolve(mapped.pos);
    if (!$pos.depth || !isCardBlock($pos.parent)) continue;
    if ($pos.parent.attrs.cardId) {
      const oldDestination = oldDoc.resolve(mapping.invert().map($pos.before() + 1, -1)).parent;
      if (isCardBlock(oldDestination) && parseBlock(oldDestination).cards.length > 0) continue;
    }
    if (parseBlock($pos.parent).cards.length === 0) continue;
    ids.delete($pos.parent.attrs.cardId);
    tr.setNodeAttribute($pos.before(), "cardId", id);
    ids.add(id);
  }
}

function repairClozeIds(
  tr: Transaction, mapping: Mapping, oldBlocks: ReturnType<typeof collectBlocks>, ranges: Range[],
) {
  const previous = new Map(oldBlocks
    .filter(({ node }) => node.attrs.cardId)
    .map((block) => [block.node.attrs.cardId, block]));
  for (const { node, pos } of collectChangedBlocks(tr.doc, ranges)) {
    if (!node.attrs.cardId) continue;
    const syntax = parseBlock(node);
    const old = previous.get(node.attrs.cardId);
    const oldSyntax = old ? parseBlock(old.node) : null;
    const oldIds = old ? clozeIdsOf(old.node, oldSyntax!) : [];
    const next: (ClozeId | undefined)[] = syntax.clozes.map(() => undefined);
    const used = new Set<string>();
    const claim = (index: number, id: string) => {
      if (next[index] || used.has(id)) return;
      const inner = syntax.clozes[index].inner;
      next[index] = { ...inner, id, answer: node.cut(inner.from, inner.to).textContent };
      used.add(id);
    };
    // Explicitly restored metadata (undo, paste, remote updates) is already
    // relative to the new block. A copy/renewal has a new block id prefix.
    if (!old || JSON.stringify(node.attrs.clozeIds) !== JSON.stringify(old.node.attrs.clozeIds)) {
      for (const entry of clozeIdsOf(node, syntax)) {
        const index = syntax.clozes.findIndex(({ inner }) => inner.from === entry.from && inner.to === entry.to);
        if (index !== -1) claim(index, entry.id);
      }
    }
    if (old && oldSyntax) {
      // Anchor inside both brace pairs: inserting at a cloze boundary moves
      // it, editing the answer keeps it, and deleting the cloze removes it.
      oldSyntax.clozes.forEach((cloze) => {
        const from = mapping.mapResult(old.pos + 2 + cloze.open.from, 1);
        const to = mapping.mapResult(old.pos + cloze.close.to, -1);
        if (from.deletedAcross || to.deletedAcross) return;
        const target = syntax.clozes.findIndex((current) =>
          pos + 2 + current.open.from === from.pos && pos + current.close.to === to.pos);
        const entry = oldIds.find((entry) => entry.from >= 0 &&
          entry.from === cloze.inner.from && entry.to === cloze.inner.to);
        if (target !== -1 && entry) claim(target, entry.id);
      });
      // Cut/paste and whole-block replacements lose their mapped positions.
      // Match remaining answers only after surviving anchors have claimed ids,
      // so prepending a duplicate cannot steal an existing cloze's history.
      syntax.clozes.forEach(({ inner }, index) => {
        if (next[index]) return;
        const answer = node.cut(inner.from, inner.to).textContent;
        const match = oldIds.find((entry) => !used.has(entry.id) && entry.answer === answer);
        if (match) claim(index, match.id);
      });
    }
    syntax.clozes.forEach((_, index) => {
      // Only the initial assignment uses cN. Later additions never reuse a
      // deleted id, including after all clozes have been removed and saved.
      const initial = !oldIds.length && validatedClozeIds(node.attrs.clozeIds) === null && validatedClozeIds(old?.node.attrs.clozeIds) === null;
      claim(index, initial ? `c${index + 1}` : `c${crypto.randomUUID()}`);
    });
    // Newly retired active entries precede older retirees. Keep a bounded
    // window for cut/paste and temporarily incomplete braces.
    const retired = oldIds.filter(({ id }) => !used.has(id)).slice(0, 20)
      .map((entry) => ({ ...entry, from: -1, to: -1 }));
    const identities = [...next, ...retired];
    if (!identities.length && node.attrs.clozeIds == null) continue;
    if (JSON.stringify(identities) !== JSON.stringify(node.attrs.clozeIds)) {
      tr.setNodeAttribute(pos, "clozeIds", identities);
    }
  }
}

function buildDecorations(doc: Node, schedules: Schedules) {
  return DecorationSet.create(
    doc,
    collectBlocks(doc, 0, doc.content.size).flatMap(({ node, pos }) =>
      blockDecorations(node, pos, schedules)),
  );
}

// The textblock holding the caret shows its `::` and braces as typed.
function activeBlock(state: EditorState, set: DecorationSet) {
  const { $head } = state.selection;
  if (!$head.parent.isTextblock || $head.depth === 0) return null;
  const from = $head.before();
  const to = from + $head.parent.nodeSize;
  const hasSyntax = set.find(from, to, (spec) => spec.syntax === true).length > 0;
  return hasSyntax ? Decoration.node(from, to, { class: "card-block-active" }) : null;
}

export const Flashcards = Extension.create({
  name: "flashcards",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          // Active ranges and retired answers retain cloze review identities
          // through edits and cut/paste, persisted with the Yjs document.
          clozeIds: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => {
              try { return validatedClozeIds(JSON.parse(element.getAttribute("data-cloze-ids") ?? "null")); }
              catch { return null; }
            },
            renderHTML: (attributes) => {
              const ids = validatedClozeIds(attributes.clozeIds);
              // Empty arrays preserve initialization without copying deleted answers.
              return ids === null ? {} : {
                "data-cloze-ids": JSON.stringify(ids.filter(({ from, to }) => from >= 0 && to >= from)),
              };
            },
          },
          clozeGroups: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => {
              try { return validatedClozeGroups(JSON.parse(element.getAttribute("data-cloze-groups") ?? "null")); }
              catch { return null; }
            },
            renderHTML: (attributes) => {
              const groups = validatedClozeGroups(attributes.clozeGroups);
              return groups.length ? { "data-cloze-groups": JSON.stringify(groups) } : {};
            },
          },
          // Stable block identity, including outside card syntax.
          cardId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute("data-card-id"),
            renderHTML: (attributes) =>
              attributes.cardId ? { "data-card-id": attributes.cardId } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      joinClozes:
        () =>
        ({ state, tr, dispatch }) => {
          const { $from, $to, empty } = state.selection;
          if (empty || !$from.sameParent($to) || !isCardBlock($from.parent)) return false;
          const node = $from.parent;
          const groups = joinedClozeGroups(node, $from.parentOffset, $to.parentOffset);
          if (!groups) return false;
          if (dispatch) tr.setNodeAttribute($from.before(), "clozeGroups", groups);
          return true;
        },
      makeCloze:
        () =>
        ({ state, tr, dispatch }) => {
          const { selection } = state;
          const { $from, $to } = selection;
          if (
            selection.empty ||
            !$from.sameParent($to) ||
            !isCardBlock($from.parent) ||
            clozeAt(state)
          ) {
            return false;
          }
          // Leave surrounding spaces outside the braces.
          let from = selection.from;
          let to = selection.to;
          const isSpace = (pos: number) =>
            state.doc.nodeAt(pos)?.isText && /\s/.test(state.doc.textBetween(pos, pos + 1));
          while (from < to && isSpace(from)) from++;
          while (to > from && isSpace(to - 1)) to--;
          if (from === to) return false;

          if (dispatch) {
            tr.insert(to, state.schema.text("}}"));
            tr.insert(from, state.schema.text("{{"));
            tr.setSelection(TextSelection.create(tr.doc, from + 2, to + 2));
          }
          return true;
        },
      removeCloze:
        () =>
        ({ state, tr, dispatch }) => {
          const cloze = clozeAt(state);
          if (!cloze) return false;
          if (dispatch) {
            tr.delete(cloze.close.from, cloze.close.to);
            tr.delete(cloze.open.from, cloze.open.to);
            tr.setSelection(
              TextSelection.create(tr.doc, cloze.open.from, cloze.close.from - 2),
            );
          }
          return true;
        },
      setCardSchedules:
        (schedules, now) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
            tr.setMeta(decorationsKey, { byId, now } satisfies Schedules);
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
      renewCardIds:
        (blockIds) =>
        ({ state, tr, dispatch }) => {
          const ids = new Set(blockIds);
          const targets: number[] = [];
          state.doc.descendants((node, pos) => {
            if (["image", "inlineImage"].includes(node.type.name) && ids.has(node.attrs.imageId)) targets.push(pos);
            if (!node.isTextblock) return true;
            if (ids.has(node.attrs.cardId)) targets.push(pos);
            return true;
          });
          if (targets.length === 0) return false;
          if (dispatch) {
            for (const pos of targets) {
              const node = tr.doc.nodeAt(pos)!;
              if (["image", "inlineImage"].includes(node.type.name)) tr.setNodeMarkup(pos, undefined, renewImageIdentity(node.attrs, () => crypto.randomUUID()));
              else tr.setNodeAttribute(pos, "cardId", crypto.randomUUID());
            }
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-c": () => clozeAt(this.editor.state)
        ? this.editor.commands.removeCloze()
        : this.editor.commands.makeCloze(),
    };
  },

  addProseMirrorPlugins() {
    return [
      // Ids appear with the first complete card in a block, and copies made
      // by paste or a split are renumbered. Outside syntax, ids stay, so a
      // card that is retyped or restored by undo keeps its history.
      new Plugin<boolean>({
        key: flashcardIdsKey,
        // Whether ids were added while Yjs rendered, which it does not save.
        state: {
          init: () => false,
          apply: (tr, value) => tr.getMeta(flashcardIdsKey) ?? value,
        },
        view: (view) => {
          let scheduled = false;
          // Any later update makes Yjs save the document, ids included.
          const writeBack = () => {
            if (scheduled || !flashcardIdsKey.getState(view.state)) return;
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (view.isDestroyed) return;
              view.dispatch(
                view.state.tr
                  .setMeta(flashcardIdsKey, false)
                  .setMeta("addToHistory", false),
              );
            });
          };
          // Yjs may already have rendered while the view was being created.
          writeBack();
          return { update: writeBack };
        },
        appendTransaction(transactions, oldState, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const ranges = changedRanges(transactions.flatMap((tr) => tr.mapping.maps));
          if (ranges.length === 0) return null;
          const tr = state.tr;
          const mapping = new Mapping(transactions.flatMap((transaction) => transaction.mapping.maps));
          const inverse = mapping.invert();
          const oldRanges = ranges.map(({ from, to }) => ({
            from: inverse.map(from, -1), to: inverse.map(to, 1),
          }));
          const oldBlocks = collectChangedBlocks(oldState.doc, oldRanges);
          carryMergedCardIds(tr, oldState.doc, mapping, oldBlocks);
          const plan = planCardIds(tr.doc, ranges, () => crypto.randomUUID());
          const images: { pos: number; attrs: Record<string, unknown>; touched: boolean }[] = [];
          tr.doc.descendants((node, pos) => {
            if (["image", "inlineImage"].includes(node.type.name)) images.push({ pos, attrs: node.attrs, touched: ranges.some(r => r.from < pos + node.nodeSize && r.to > pos) });
          });
          const seen = new Set<unknown>();
          for (const image of images.sort((a,b) => Number(a.touched) - Number(b.touched))) {
            if (!image.attrs.imageId || seen.has(image.attrs.imageId)) tr.setNodeMarkup(image.pos, undefined, renewImageIdentity(image.attrs, () => crypto.randomUUID()));
            else seen.add(image.attrs.imageId);
          }
          for (const { pos, cardId } of plan) tr.setNodeAttribute(pos, "cardId", cardId);
          repairClozeIds(tr, mapping, oldBlocks, ranges);
          if (!tr.docChanged) return null;
          if (transactions.some((transaction) => transaction.getMeta(ySyncPluginKey)?.isChangeOrigin)) {
            tr.setMeta(flashcardIdsKey, true);
          }
          return tr;
        },
        props: {
          transformPasted(slice, view) {
            // Internal drops keep the dragged slice: move/copy modifiers can
            // change after dragstart. Duplicate repair above renews copy ids.
            if (slice === view.dragging?.slice) return slice;
            const map = (fragment: import("@tiptap/pm/model").Fragment): import("@tiptap/pm/model").Fragment => Fragment.fromArray(Array.from({ length: fragment.childCount }, (_, i) => {
              const node = fragment.child(i);
              return ["image", "inlineImage"].includes(node.type.name)
                ? node.type.create(renewImageIdentity(node.attrs, () => crypto.randomUUID()), node.content, node.marks)
                : node.copy(map(node.content));
            }));
            return new Slice(map(slice.content), slice.openStart, slice.openEnd);
          },
        },
      }),
      new Plugin({
        key: decorationsKey,
        state: {
          init: (_, { doc }) => {
            const schedules: Schedules = { byId: new Map(), now: Date.now() };
            return { set: buildDecorations(doc, schedules), schedules };
          },
          apply(tr, value) {
            const update = tr.getMeta(decorationsKey) as Schedules | undefined;
            if (update) return { set: buildDecorations(tr.doc, update), schedules: update };
            if (!tr.docChanged) return value;
            const { schedules } = value;
            // Attribute-only edits (joining clozes, assigning ids, undo) have
            // no mapped text ranges, but change the cards and their info dot.
            if (!changedRanges(tr.mapping.maps).length) return { set: buildDecorations(tr.doc, schedules), schedules };
            let next = value.set.map(tr.mapping, tr.doc);
            const seen = new Set<number>();
            for (const { from, to } of changedRanges(tr.mapping.maps)) {
              for (const { node, pos } of collectBlocks(tr.doc, from, to)) {
                if (seen.has(pos)) continue;
                seen.add(pos);
                const end = pos + node.nodeSize;
                const stale = next
                  .find(pos, end)
                  .filter((decoration) => decoration.from >= pos && decoration.to <= end);
                next = next.remove(stale).add(tr.doc, blockDecorations(node, pos, schedules));
              }
            }
            return { set: next, schedules };
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
            const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!direction) return false;
            const { selection } = view.state;
            if (!(selection instanceof TextSelection) || (!selection.empty && !event.shiftKey)) return false;
            const { $head } = selection;
            if (!isCardBlock($head.parent)) return false;
            const start = $head.start();
            const markers = parseBlock($head.parent).clozes.flatMap(({ open, close }) => [open, close]);
            let offset = $head.parentOffset;
            // These positions draw at the same place as the adjacent visible
            // text. Cross the marker and then move by one visible character.
            for (const { from, to } of markers) {
              if (direction > 0 && offset >= from && offset < to) offset = to;
              if (direction < 0 && offset > from && offset <= to) offset = from;
            }
            let target = offset + direction;
            for (const { from, to } of markers) {
              if (target > from && target < to) target = direction > 0 ? to : from;
            }
            const atMarkerBoundary = markers.some(({ from, to }) => target === from || target === to);
            if (target === $head.parentOffset + direction && !atMarkerBoundary) return false;
            target = Math.max(0, Math.min($head.parent.content.size, target)) + start;
            // Avoid native cursor movement through zero-size text, which can
            // scroll the entire page to the hidden marker's caret rectangle.
            view.dispatch(view.state.tr.setSelection(TextSelection.create(
              view.state.doc, event.shiftKey ? selection.anchor : target, target,
            )));
            return true;
          },
          decorations(state) {
            const set = decorationsKey.getState(state)?.set;
            if (!set) return null;
            const active = activeBlock(state, set);
            return active ? set.add(state.doc, [active]) : set;
          },
        },
      }),
    ];
  },
});
