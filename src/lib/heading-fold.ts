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
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { getFocusedSectionRange, sectionFocusKey } from "./section-focus.ts";

type HeadingFoldState = {
  // Folded headings by their table-of-contents id. Positions would not do: the
  // Yjs binding replaces the whole document when it renders, and ids are saved
  // with the note. Ids of deleted headings are kept so undo brings the fold back.
  folded: string[];
  // Two sets: when a block holding decorations is edited, ProseMirror rebuilds
  // its set from scratch, so the many hidden blocks stay apart from the toggles
  // inside headings, where typing happens.
  hidden: DecorationSet;
  toggles: DecorationSet;
  // What the decorations show, block by block; see foldLayout.
  layout: string;
};

type FoldAction = { type: "toggle"; id: string } | { type: "set"; ids: string[] };

export const headingFoldKey = new PluginKey<HeadingFoldState>("heading-fold");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    headingFold: {
      toggleFold: (headingPos: number) => ReturnType;
      setFolds: (headingIds: string[]) => ReturnType;
      // Fold the innermost open section around the caret, or the one above
      // it when that is folded already; unfold the innermost folded one.
      foldCurrentSection: () => ReturnType;
      unfoldCurrentSection: () => ReturnType;
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

// The TOC extension gives every heading with text a unique id.
function headingId(node: PMNode | null | undefined): string | null {
  return node?.type.name === "heading" ? (node.attrs["data-toc-id"] ?? null) : null;
}

// The content each folded heading hides: from after the heading to its section end.
function hiddenRanges(doc: PMNode, folded: string[]) {
  const foldedSet = new Set(folded);
  const ends = sectionEnds(doc);
  const ranges: { heading: number; id: string; from: number; to: number }[] = [];

  doc.forEach((node, pos) => {
    const id = headingId(node);
    if (id === null || !foldedSet.has(id)) return;
    const from = pos + node.nodeSize;
    const to = ends.get(pos)!;
    if (to > from) ranges.push({ heading: pos, id, from, to });
  });
  return ranges;
}

// What the folded headings currently hide.
export function getFoldedRanges(state: EditorState) {
  return hiddenRanges(state.doc, headingFoldKey.getState(state)?.folded ?? []);
}

// Ids of the folded headings still in the document, for saving.
export function getFoldedIds(state: EditorState) {
  return getFoldedRanges(state).map((range) => range.id);
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
    const id = pos === undefined ? null : headingId(view.state.doc.nodeAt(pos - 1));
    if (id !== null) view.dispatch(foldTransaction(view.state, { type: "toggle", id }));
  });
  return button;
}

// One token per decorated top-level block, without positions: a toggle (folded
// or open, with its heading id) or a hidden block. Typing text leaves it as is,
// so the decorations can be mapped rather than rebuilt, which is costly in long
// notes: ProseMirror scans every decoration for each top-level block.
function foldLayout(doc: PMNode, folded: string[]): string {
  const foldedSet = new Set(folded);
  const ends = sectionEnds(doc);
  const tokens: string[] = [];
  let hiddenUntil = -1;

  doc.forEach((node, pos) => {
    const nodeEnd = pos + node.nodeSize;
    if (pos < hiddenUntil) tokens.push("x");
    const id = headingId(node);
    if (id === null) return;
    const end = ends.get(pos)!;
    if (end <= nodeEnd) return;
    const isFolded = foldedSet.has(id);
    if (isFolded) hiddenUntil = Math.max(hiddenUntil, end);
    tokens.push(`${isFolded ? "f" : "o"}${id}`);
  });
  return tokens.join(" ");
}

function buildState(doc: PMNode, folded: string[]): HeadingFoldState {
  return {
    folded,
    ...buildDecorations(doc, folded),
    layout: foldLayout(doc, folded),
  };
}

function buildDecorations(doc: PMNode, folded: string[]) {
  const foldedSet = new Set(folded);
  const ends = sectionEnds(doc);
  const hidden: Decoration[] = [];
  const toggles: Decoration[] = [];
  let hiddenUntil = -1;

  doc.forEach((node, pos) => {
    const nodeEnd = pos + node.nodeSize;
    if (pos < hiddenUntil) {
      hidden.push(Decoration.node(pos, nodeEnd, { class: "section-hidden" }));
    }
    const id = headingId(node);
    // An empty heading has no id until it gets text.
    if (id === null) return;

    const end = ends.get(pos)!;
    // Nothing to fold under this heading.
    if (end <= nodeEnd) return;

    const isFolded = foldedSet.has(id);
    if (isFolded) hiddenUntil = Math.max(hiddenUntil, end);
    toggles.push(
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

  return {
    hidden: DecorationSet.create(doc, hidden),
    toggles: DecorationSet.create(doc, toggles),
  };
}

// The foldable headings whose sections hold the caret, outermost first. A
// heading's own line counts as inside its section.
function sectionsAround(state: EditorState) {
  const ends = sectionEnds(state.doc);
  const { head } = state.selection;
  const around: { pos: number; id: string }[] = [];

  state.doc.forEach((node, pos) => {
    const id = headingId(node);
    if (id === null || pos >= head) return;
    const end = ends.get(pos)!;
    if (head <= end && end > pos + node.nodeSize) around.push({ pos, id });
  });
  return around;
}

function applyAction(folded: string[], action: FoldAction): string[] {
  if (action.type === "set") return [...new Set(action.ids)];
  return folded.includes(action.id)
    ? folded.filter((id) => id !== action.id)
    : [...folded, action.id];
}

function foldTransaction(state: EditorState, action: FoldAction): Transaction {
  const tr = state.tr.setMeta(headingFoldKey, action);
  const next = applyAction(headingFoldKey.getState(state)?.folded ?? [], action);

  // A caret inside content that is about to be hidden moves up to its heading.
  const { head } = state.selection;
  const covering = hiddenRanges(state.doc, next).find(
    (range) => head > range.from && head < range.to,
  );
  if (covering) {
    const heading = state.doc.nodeAt(covering.heading)!;
    tr.setSelection(
      TextSelection.create(state.doc, covering.heading + heading.nodeSize - 1),
    );
    const focus = getFocusedSectionRange(state);
    if (focus && (tr.selection.head < focus.from || tr.selection.head >= focus.to)) {
      tr.setMeta(sectionFocusKey, { type: "clear" });
    }
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
          const id = headingId(state.doc.nodeAt(headingPos));
          if (id === null) return false;
          dispatch?.(foldTransaction(state, { type: "toggle", id }));
          return true;
        },
      setFolds:
        (headingIds) =>
        ({ state, dispatch }) => {
          dispatch?.(foldTransaction(state, { type: "set", ids: headingIds }));
          return true;
        },
      foldCurrentSection:
        () =>
        ({ state, dispatch }) => {
          const folded = headingFoldKey.getState(state)?.folded ?? [];
          const target = sectionsAround(state)
            .reverse()
            .find((section) => !folded.includes(section.id));
          if (!target) return false;
          // A caret in the hidden content moves up onto the heading.
          dispatch?.(
            foldTransaction(state, { type: "toggle", id: target.id }).scrollIntoView(),
          );
          return true;
        },
      unfoldCurrentSection:
        () =>
        ({ state, dispatch }) => {
          const folded = headingFoldKey.getState(state)?.folded ?? [];
          const target = sectionsAround(state)
            .reverse()
            .find((section) => folded.includes(section.id));
          if (!target) return false;
          dispatch?.(foldTransaction(state, { type: "toggle", id: target.id }));
          return true;
        },
    };
  },

  // Like VS Code's fold and unfold.
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-[": () => this.editor.commands.foldCurrentSection(),
      "Mod-Alt-]": () => this.editor.commands.unfoldCurrentSection(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<HeadingFoldState>({
        key: headingFoldKey,
        state: {
          init: (_, state) => buildState(state.doc, []),
          apply(tr, value) {
            const action = tr.getMeta(headingFoldKey) as FoldAction | undefined;
            if (!action && !tr.docChanged) return value;

            const folded = action ? applyAction(value.folded, action) : value.folded;
            const layout = foldLayout(tr.doc, folded);
            if (layout === value.layout) {
              // The Yjs binding replaces the whole document when it renders,
              // which drops mapped decorations; rebuild if any went missing.
              const hidden = value.hidden.map(tr.mapping, tr.doc);
              const toggles = value.toggles.map(tr.mapping, tr.doc);
              const expected = layout ? layout.split(" ").length : 0;
              if (hidden.find().length + toggles.find().length === expected) {
                return { folded, hidden, toggles, layout };
              }
            }
            return buildState(tr.doc, folded);
          },
        },
        props: {
          decorations: (state) => headingFoldKey.getState(state)?.hidden,
        },
        // Unfold any section the caret moves into, e.g. with the arrow keys
        // or a search match, so it never sits in hidden content. Yjs renders
        // move the caret as a side effect, which is not the user moving it.
        appendTransaction(transactions, oldState, newState) {
          if (
            !transactions.some(
              (tr) =>
                (tr.selectionSet || tr.docChanged) &&
                !tr.getMeta(ySyncPluginKey)?.isChangeOrigin,
            ) ||
            oldState.selection.eq(newState.selection)
          ) {
            return null;
          }
          const { folded } = headingFoldKey.getState(newState)!;
          const { head } = newState.selection;
          const revealed = hiddenRanges(newState.doc, folded)
            .filter((range) => head > range.from && head < range.to)
            .map((range) => range.id);
          if (!revealed.length) return null;

          return newState.tr.setMeta(headingFoldKey, {
            type: "set",
            ids: folded.filter((id) => !revealed.includes(id)),
          } satisfies FoldAction);
        },
      }),
      new Plugin({
        props: {
          decorations: (state) => headingFoldKey.getState(state)?.toggles,
        },
      }),
    ];
  },
});
