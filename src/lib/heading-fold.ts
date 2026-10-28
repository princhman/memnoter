import { Extension } from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

type HeadingFoldState = {
  // Positions of folded headings, kept in document order.
  folded: number[];
  decorations: DecorationSet;
};

type FoldAction = { type: "toggle"; position: number } | { type: "set"; positions: number[] };

export const headingFoldKey = new PluginKey<HeadingFoldState>("heading-fold");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    headingFold: {
      toggleFold: (headingPos: number) => ReturnType;
      setFolds: (headingPositions: number[]) => ReturnType;
    };
  }
}

// Where each top-level heading's section ends: the next heading at its level
// or higher, or the end of the document.
function sectionEnds(doc: PMNode): Map<number, number> {
  const ends = new Map<number, number>();
  const open: { pos: number; level: number }[] = [];

  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    while (open.length && open[open.length - 1].level >= level) {
      ends.set(open.pop()!.pos, pos);
    }
    open.push({ pos, level });
  });
  for (const heading of open) ends.set(heading.pos, doc.content.size);

  return ends;
}

// The content each folded heading hides: from after the heading to its section end.
function hiddenRanges(doc: PMNode, folded: number[]) {
  const ends = sectionEnds(doc);
  return folded.flatMap((pos) => {
    const end = ends.get(pos);
    const from = pos + doc.nodeAt(pos)!.nodeSize;
    return end !== undefined && end > from ? [{ heading: pos, from, to: end }] : [];
  });
}

// What the folded headings currently hide.
export function getFoldedRanges(state: EditorState) {
  return hiddenRanges(state.doc, headingFoldKey.getState(state)?.folded ?? []);
}

function createToggle(view: EditorView, getPos: () => number | undefined, folded: boolean) {
  const button = document.createElement("span");
  button.className = "heading-fold-toggle";
  button.contentEditable = "false";
  button.setAttribute("role", "button");
  button.setAttribute("aria-label", folded ? "Unfold section" : "Fold section");
  if (folded) button.dataset.folded = "";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  // Keep the caret where it is; folding is not an edit.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    const pos = getPos();
    // The widget sits at the start of the heading's content.
    if (pos !== undefined) {
      view.dispatch(
        foldTransaction(view.state, { type: "toggle", position: pos - 1 }),
      );
    }
  });
  return button;
}

function buildDecorations(doc: PMNode, folded: number[]): DecorationSet {
  const foldedSet = new Set(folded);
  const ends = sectionEnds(doc);
  const decorations: Decoration[] = [];
  let hiddenUntil = -1;

  doc.forEach((node, pos) => {
    const nodeEnd = pos + node.nodeSize;
    if (pos < hiddenUntil) {
      decorations.push(Decoration.node(pos, nodeEnd, { class: "section-hidden" }));
    }
    if (node.type.name !== "heading") return;

    const end = ends.get(pos)!;
    // Nothing to fold under this heading.
    if (end <= nodeEnd) return;

    const isFolded = foldedSet.has(pos);
    if (isFolded) hiddenUntil = Math.max(hiddenUntil, end);
    decorations.push(
      Decoration.widget(
        pos + 1,
        (view, getPos) => createToggle(view, getPos, isFolded),
        {
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
          key: isFolded ? "fold-folded" : "fold-open",
        },
      ),
    );
  });

  return DecorationSet.create(doc, decorations);
}

function isHeadingAt(doc: PMNode, pos: number) {
  return pos >= 0 && pos < doc.content.size && doc.nodeAt(pos)?.type.name === "heading";
}

function foldTransaction(state: EditorState, action: FoldAction): Transaction {
  const tr = state.tr.setMeta(headingFoldKey, action);
  const current = headingFoldKey.getState(state)?.folded ?? [];
  const next =
    action.type === "set"
      ? action.positions
      : current.includes(action.position)
        ? current.filter((pos) => pos !== action.position)
        : [...current, action.position];

  // A caret inside content that is about to be hidden moves up to its heading.
  const { head } = state.selection;
  const covering = hiddenRanges(
    state.doc,
    next.filter((pos) => isHeadingAt(state.doc, pos)),
  ).find((range) => head > range.from && head < range.to);
  if (covering) {
    const heading = state.doc.nodeAt(covering.heading)!;
    tr.setSelection(
      TextSelection.create(state.doc, covering.heading + heading.nodeSize - 1),
    );
  }
  return tr;
}

export const HeadingFold = Extension.create({
  name: "headingFold",

  addCommands() {
    return {
      toggleFold:
        (headingPos) =>
        ({ state, dispatch }) => {
          if (!isHeadingAt(state.doc, headingPos)) return false;
          dispatch?.(foldTransaction(state, { type: "toggle", position: headingPos }));
          return true;
        },
      setFolds:
        (headingPositions) =>
        ({ state, dispatch }) => {
          dispatch?.(foldTransaction(state, { type: "set", positions: headingPositions }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<HeadingFoldState>({
        key: headingFoldKey,
        state: {
          init: (_, state) => ({
            folded: [],
            decorations: buildDecorations(state.doc, []),
          }),
          apply(tr, value) {
            const action = tr.getMeta(headingFoldKey) as FoldAction | undefined;
            if (!action && !tr.docChanged) return value;

            let folded = value.folded;
            if (tr.docChanged) {
              folded = folded.flatMap((pos) => {
                const mapped = tr.mapping.mapResult(pos, -1);
                return mapped.deleted ? [] : [mapped.pos];
              });
            }
            if (action?.type === "toggle") {
              folded = folded.includes(action.position)
                ? folded.filter((pos) => pos !== action.position)
                : [...folded, action.position];
            } else if (action?.type === "set") {
              folded = action.positions;
            }
            folded = [...new Set(folded)]
              .filter((pos) => isHeadingAt(tr.doc, pos))
              .sort((a, b) => a - b);

            return { folded, decorations: buildDecorations(tr.doc, folded) };
          },
        },
        props: {
          decorations: (state) => headingFoldKey.getState(state)?.decorations,
        },
        // Unfold any section the caret moves into, e.g. with the arrow keys
        // or a search match, so it never sits in hidden content.
        appendTransaction(transactions, oldState, newState) {
          if (
            !transactions.some((tr) => tr.selectionSet || tr.docChanged) ||
            oldState.selection.eq(newState.selection)
          ) {
            return null;
          }
          const { folded } = headingFoldKey.getState(newState)!;
          const { head } = newState.selection;
          const revealed = hiddenRanges(newState.doc, folded)
            .filter((range) => head > range.from && head < range.to)
            .map((range) => range.heading);
          if (!revealed.length) return null;

          return newState.tr.setMeta(headingFoldKey, {
            type: "set",
            positions: folded.filter((pos) => !revealed.includes(pos)),
          } satisfies FoldAction);
        },
      }),
    ];
  },
});
