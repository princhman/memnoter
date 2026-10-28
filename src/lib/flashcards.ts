import { Fragment, Slice } from "@tiptap/pm/model";
import { renewImageIdentity } from "./occlusion.ts";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { changedRanges, parseBlock, planCardIds } from "./cards.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    flashcards: {
      // Wrap the selection in {{…}}, making it a cloze card.
      makeCloze: () => ReturnType;
      // Give these blocks fresh card ids, e.g. when another note owns them.
      renewCardIds: (blockIds: string[]) => ReturnType;
    };
  }
}

const decorationsKey = new PluginKey<DecorationSet>("flashcardDecorations");

// Card syntax stays real, editable text: decorations only restyle it, and
// nothing is hidden from the caret. A faint `::` reads as an arrow until the
// caret enters its block, cloze braces are faint and small, and the hidden
// text gets a dotted underline. Card blocks get a faint margin marker.
function blockDecorations(node: Node, pos: number): Decoration[] {
  const syntax = parseBlock(node);
  const start = pos + 1;
  const decorations: Decoration[] = [];
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
      }, { separator: true }),
    );
  }
  for (const { open, inner, close } of syntax.clozes) {
    decorations.push(
      Decoration.inline(start + open.from, start + open.to, { class: "cloze-brace" }),
      Decoration.inline(start + inner.from, start + inner.to, { class: "cloze-text" }),
      Decoration.inline(start + close.from, start + close.to, { class: "cloze-brace" }),
    );
  }
  return decorations;
}

function isCardBlock(node: Node) {
  return node.isTextblock && !node.type.spec.code && "cardId" in node.attrs;
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

function buildDecorations(doc: Node) {
  return DecorationSet.create(
    doc,
    collectBlocks(doc, 0, doc.content.size).flatMap(({ node, pos }) => blockDecorations(node, pos)),
  );
}

// The textblock holding the caret shows its `::` as typed.
function activeBlock(state: EditorState, set: DecorationSet) {
  const { $head } = state.selection;
  if (!$head.parent.isTextblock || $head.depth === 0) return null;
  const from = $head.before();
  const to = from + $head.parent.nodeSize;
  const hasSeparator = set.find(from, to, (spec) => spec.separator === true).length > 0;
  return hasSeparator ? Decoration.node(from, to, { class: "card-block-active" }) : null;
}

export const Flashcards = Extension.create({
  name: "flashcards",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          // A stable id for the cards in this block, kept in the Yjs document
          // so editing the text keeps their review history.
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
      makeCloze:
        () =>
        ({ state, tr, dispatch }) => {
          const { selection } = state;
          const { $from, $to } = selection;
          if (
            selection.empty ||
            !$from.sameParent($to) ||
            !isCardBlock($from.parent)
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

  addProseMirrorPlugins() {
    return [
      // Ids appear with the first complete card in a block, and copies made
      // by paste or a split are renumbered. Outside syntax, ids stay, so a
      // card that is retyped or restored by undo keeps its history.
      new Plugin({
        key: new PluginKey("flashcardIds"),
        appendTransaction(transactions, _oldState, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const ranges = changedRanges(transactions.flatMap((tr) => tr.mapping.maps));
          if (ranges.length === 0) return null;
          const plan = planCardIds(state.doc, ranges, () => crypto.randomUUID());
          const tr = state.tr;
          const images: { pos: number; attrs: Record<string, unknown>; touched: boolean }[] = [];
          state.doc.descendants((node, pos) => {
            if (["image", "inlineImage"].includes(node.type.name)) images.push({ pos, attrs: node.attrs, touched: ranges.some(r => r.from < pos + node.nodeSize && r.to > pos) });
          });
          const seen = new Set<unknown>();
          for (const image of images.sort((a,b) => Number(a.touched) - Number(b.touched))) {
            if (!image.attrs.imageId || seen.has(image.attrs.imageId)) tr.setNodeMarkup(image.pos, undefined, renewImageIdentity(image.attrs, () => crypto.randomUUID()));
            else seen.add(image.attrs.imageId);
          }
          for (const { pos, cardId } of plan) tr.setNodeAttribute(pos, "cardId", cardId);
          return tr.docChanged ? tr : null;
        },
        props: {
          transformPasted(slice) {
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
          init: (_, { doc }) => buildDecorations(doc),
          apply(tr, set) {
            if (!tr.docChanged) return set;
            let next = set.map(tr.mapping, tr.doc);
            const seen = new Set<number>();
            for (const { from, to } of changedRanges(tr.mapping.maps)) {
              for (const { node, pos } of collectBlocks(tr.doc, from, to)) {
                if (seen.has(pos)) continue;
                seen.add(pos);
                const end = pos + node.nodeSize;
                const stale = next
                  .find(pos, end)
                  .filter((decoration) => decoration.from >= pos && decoration.to <= end);
                next = next.remove(stale).add(tr.doc, blockDecorations(node, pos));
              }
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const set = decorationsKey.getState(state);
            if (!set) return null;
            const active = activeBlock(state, set);
            return active ? set.add(state.doc, [active]) : set;
          },
        },
      }),
    ];
  },
});
