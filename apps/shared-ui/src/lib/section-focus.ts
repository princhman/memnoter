import { headingId, outline } from "./outline.ts";
import { Extension, isiOS, isMacOS } from "@tiptap/core";
import { AllSelection, type EditorState, PluginKey, Plugin, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { StepMap, type Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import { ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";
import { XmlElement, type Transaction as YTransaction } from "yjs";
import { backspaceHeading } from "./heading-hierarchy";

export const sectionFocusKey = new PluginKey<number | null>("section-focus");

function isHeadingPosition(
  doc: EditorState["doc"],
  position: unknown,
): position is number {
  return typeof position === "number" && outline(doc).some(item => item.pos === position);
}
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sectionFocus: {
      showSection: (headingPos: number) => ReturnType;
      showDocument: () => ReturnType;
    };
  }
}

type SectionCrumb = {
  pos: number;
  level: number;
  title: string;
};

export function getFocusedSectionPath(editor: Editor): SectionCrumb[] {
  const focusedPos = sectionFocusKey.getState(editor.state);
  if (
    focusedPos == null ||
    focusedPos < 0 ||
    focusedPos >= editor.state.doc.content.size
  ) return [];

  const heading = outline(editor.state.doc).find(item => item.pos === focusedPos);
  return heading ? [...heading.ancestors, heading] : [];
}

// The focused heading and everything up to the next heading at its level or higher.
export function getFocusedSectionRange(
  state: EditorState,
): { from: number; to: number } | null {
  return getSectionRange(state.doc, sectionFocusKey.getState(state));
}

// A heading and everything up to the next heading at its level or higher.
export function getSectionRange(
  doc: EditorState["doc"],
  headingPos: unknown,
): { from: number; to: number } | null {
  if (typeof headingPos !== "number") return null;
  const heading = outline(doc).find(item => item.pos === headingPos);
  return heading ? { from: heading.pos, to: heading.end } : null;
}

const sectionMarksKey = new PluginKey<DecorationSet>("section-focus-marks");

// Marks only the focused heading and the first block after its section; CSS
// hides everything outside them. A decoration per hidden block would cost
// time on every keystroke in long notes, as ProseMirror checks each top-level
// decoration against each block.
function buildSectionMarks(state: EditorState): DecorationSet {
  const range = getFocusedSectionRange(state);
  if (!range) return DecorationSet.empty;

  const heading = state.doc.nodeAt(range.from)!;
  const decorations = [
    Decoration.node(range.from, range.from + heading.nodeSize, {
      class: "section-focus-start",
    }),
  ];
  const after = state.doc.nodeAt(range.to);
  if (after) {
    decorations.push(
      Decoration.node(range.to, range.to + after.nodeSize, {
        class: "section-focus-end",
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

// Background repairs must persist even when their blocks are hidden.
export const sectionFocusBackground = "section-focus-background";

function selectionCrossesBoundary(state: EditorState) {
  const range = getFocusedSectionRange(state);
  return !!range && (state.selection.from < range.from || state.selection.to > range.to);
}

function blockInputOverHiddenSelection(view: EditorView, event: Event) {
  if (!selectionCrossesBoundary(view.state)) return false;
  event.preventDefault();
  return true;
}

function deletesAcrossBoundary(state: EditorState, direction: -1 | 1) {
  if (sectionFocusKey.getState(state) == null) return false;
  const range = getFocusedSectionRange(state);
  if (!range) return false;
  if (selectionCrossesBoundary(state)) return true;
  const { empty, $head } = state.selection;
  const edge = direction === 1 ? range.to : range.from;
  const documentEdge = direction === 1 ? state.doc.content.size : 0;
  // A caret inside the last list item has a closing token for each ancestor.
  return empty && edge !== documentEdge &&
    ($head.pos === edge || $head.pos + direction * $head.depth === edge);
}

function changesHiddenContent(transaction: Transaction, range: { from: number; to: number }) {
  let { from, to } = range;
  for (const [index, step] of transaction.steps.entries()) {
    const map = step.getMap();
    if (map === StepMap.empty) {
      const before = transaction.docs[index].content;
      const after = (transaction.docs[index + 1] ?? transaction.doc).content;
      const start = before.findDiffStart(after);
      if (start != null && (start < from || (before.findDiffEnd(after)?.a ?? start) > to)) return true;
    } else {
      let outside = false;
      map.forEach((start, end) => { if (start < from || end > to) outside = true; });
      if (outside) return true;
    }
    from = map.map(from, -1);
    to = map.map(to, 1);
  }
  return false;
}

// Text selections need inline endpoints. A section ending in a block atom
// needs a selection whose endpoint can sit after that atom at the document level.
export class SectionSelection extends Selection {
  eq(other: Selection) {
    return other instanceof SectionSelection && this.anchor === other.anchor && this.head === other.head;
  }

  map(doc: EditorState["doc"], mapping: Mappable): Selection {
    const anchor = mapping.map(this.anchor, 1);
    const head = mapping.map(this.head, -1);
    return anchor < head
      ? new SectionSelection(doc.resolve(anchor), doc.resolve(head))
      : Selection.near(doc.resolve(anchor));
  }

  toJSON() {
    return { type: "section-selection", anchor: this.anchor, head: this.head };
  }

  static fromJSON(doc: EditorState["doc"], json: { anchor: number; head: number }) {
    return new SectionSelection(doc.resolve(json.anchor), doc.resolve(json.head));
  }
}
Selection.jsonID("section-selection", SectionSelection);

export const SectionFocus = Extension.create({
  name: "section-focus",
  // Intercept boundary input before MarkdownPaste and the default keymaps.
  priority: 1101,
  addKeyboardShortcuts() {
    const forward = () => deletesAcrossBoundary(this.editor.state, 1);
    const backward = () => deletesAcrossBoundary(this.editor.state, -1);
    return {
      Delete: forward,
      "Mod-Delete": forward,
      Backspace: () => {
        if (!backward()) return false;
        // Give the visible heading conversion the same chance as in the full
        // note. Consume the key even if it fails so the fallback cannot join.
        if (!selectionCrossesBoundary(this.editor.state)) backspaceHeading(this.editor);
        return true;
      },
      "Mod-Backspace": backward,
      "Shift-Backspace": backward,
      ...((isMacOS() || isiOS()) && {
        "Ctrl-d": forward,
        "Alt-Delete": forward,
        "Alt-d": forward,
        "Ctrl-Alt-Backspace": forward,
        "Ctrl-h": backward,
        "Alt-Backspace": backward,
      }),
    };
  },
  addCommands() {
    return {
      showSection:
        (headingPos: number) =>
        ({ state, dispatch }) => {
          if (!isHeadingPosition(state.doc, headingPos)) return false;
          dispatch?.(
            state.tr.setMeta(sectionFocusKey, {
              type: "show",
              position: headingPos,
            }),
          );
          return true;
        },
      showDocument:
        () =>
        ({ state, dispatch }) => {
          dispatch?.(state.tr.setMeta(sectionFocusKey, { type: "clear" }));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    let syncedHeading: XmlElement | null = null;
    return [
      new Plugin<number | null>({
        key: sectionFocusKey,
        view(view) {
          const binding: unknown = ySyncPluginKey.getState(view.state)?.binding;
          if (!(binding instanceof ProsemirrorBinding)) return {};
          // Capture the item while PM still reflects the pre-sync fragment.
          // Local PM writes already have their own transaction mapping.
          const capture = (transaction: YTransaction) => {
            const { state } = view;
            const pos = sectionFocusKey.getState(state);
            if (pos == null || transaction.origin === ySyncPluginKey ||
                binding.type.length !== state.doc.childCount) return;
            const item = binding.type.get(state.doc.resolve(pos).index());
            if (item instanceof XmlElement) syncedHeading = item;
          };
          const clear = () => { syncedHeading = null; };
          binding.doc.on("beforeTransaction", capture);
          binding.doc.on("afterAllTransactions", clear);
          return {
            destroy() {
              binding.doc.off("beforeTransaction", capture);
              binding.doc.off("afterAllTransactions", clear);
            },
          };
        },
        props: {
          handleTextInput(view, from, to) {
            const range = getFocusedSectionRange(view.state);
            return !!range && (from < range.from || to > range.to || selectionCrossesBoundary(view.state));
          },
          handlePaste: view => selectionCrossesBoundary(view.state),
          handleDOMEvents: {
            keydown(view, event) {
              // ProseMirror skips its keymap during composition. Intercept these
              // editing keys before the browser can replace an escaped selection.
              if (event.key !== "Delete" && event.key !== "Backspace" && event.key !== "Enter") return false;
              if (!selectionCrossesBoundary(view.state)) return false;
              event.preventDefault();
              return true;
            },
            beforeinput(view, event) {
              const { inputType } = event;
              if (!inputType.startsWith("insert") && !inputType.startsWith("delete")) return false;
              const range = getFocusedSectionRange(view.state);
              if (!range) return false;
              const outside = event.getTargetRanges?.().some(({ startContainer, startOffset, endContainer, endOffset }) =>
                view.dom.contains(startContainer) && view.dom.contains(endContainer) &&
                (view.posAtDOM(startContainer, startOffset) < range.from ||
                 view.posAtDOM(endContainer, endOffset) > range.to));
              const boundaryDelete = inputType.endsWith("Forward") && deletesAcrossBoundary(view.state, 1) ||
                inputType.endsWith("Backward") && deletesAcrossBoundary(view.state, -1);
              if (!event.cancelable || !(outside || boundaryDelete || selectionCrossesBoundary(view.state))) return false;
              event.preventDefault();
              return true;
            },
            // Composition start can delete a spanning selection before
            // ProseMirror starts tagging its transactions as composition.
            compositionstart: blockInputOverHiddenSelection,
            compositionupdate: blockInputOverHiddenSelection,
            cut: blockInputOverHiddenSelection,
            paste: blockInputOverHiddenSelection,
          },
        },
        filterTransaction(transaction, state) {
          const input = transaction.getMeta("uiEvent");
          if (!transaction.docChanged ||
            !(transaction.getMeta("composition") || input === "cut" || input === "paste" || input === "drop")) return true;
          const range = getFocusedSectionRange(state);
          return !range || !changesHiddenContent(transaction, range);
        },
        appendTransaction(transactions, oldState, state) {
          const selectAll = state.selection instanceof AllSelection;
          const sync = transactions[0]?.getMeta(ySyncPluginKey);
          const restore = oldState.selection instanceof SectionSelection && sync?.isChangeOrigin && !sync.isUndoRedoOperation;
          if (!selectAll && !restore) return null;
          const range = getFocusedSectionRange(state);
          if (!range) return null;
          if (restore) {
            // Yjs restores text endpoints, which cannot sit after a block atom.
            return state.tr.setSelection(new SectionSelection(state.doc.resolve(range.from), state.doc.resolve(range.to)));
          }
          const end = Selection.findFrom(state.doc.resolve(range.to), -1);
          const selection = end instanceof TextSelection
            ? TextSelection.create(state.doc, range.from + 1, end.to)
            : new SectionSelection(state.doc.resolve(range.from), state.doc.resolve(range.to));
          return state.tr.setSelection(selection);
        },
        state: {
          init: () => null,
          apply(transaction, currentPosition, oldState) {
            const action = transaction.getMeta(sectionFocusKey);

            if (action?.type === "clear") {
              return null;
            }

            if (action?.type === "show") {
              return isHeadingPosition(transaction.doc, action.position)
                ? action.position
                : null;
            }

            if (currentPosition !== null && transaction.docChanged) {
              const before = getSectionRange(oldState.doc, currentPosition);
              if (!before) return null;
              const sync = transaction.getMeta(ySyncPluginKey);
              let position = transaction.mapping.map(currentPosition, 1);
              if (sync?.isChangeOrigin) {
                // The binding renders a full replacement, even for a one-letter change.
                const binding: unknown = ySyncPluginKey.getState(oldState)?.binding;
                const survivingNode = syncedHeading && binding instanceof ProsemirrorBinding
                  ? binding.mapping.get(syncedHeading) : null;
                const heading = oldState.doc.nodeAt(currentPosition);
                if (!heading) return null;
                const id = headingId(heading);
                const matches = outline(transaction.doc).filter(item => {
                  if (survivingNode) return transaction.doc.nodeAt(item.pos) === survivingNode;
                  return id ? item.id === id : item.id == null && transaction.doc.nodeAt(item.pos)?.eq(heading);
                });
                if (matches.length !== 1) return null;
                position = matches[0].pos;
              }
              const after = getSectionRange(transaction.doc, position);
              if (!after) return null;
              const background = sync?.isChangeOrigin ? !sync.isUndoRedoOperation :
                transaction.getMeta("appendedTransaction") || transaction.getMeta(sectionFocusBackground);
              if (!background) {
                const oldDoc = oldState.doc.content;
                const newDoc = transaction.doc.content;
                // Compare both hidden sides, including inserts at the section ends.
                const mayChangeHidden = sync?.isChangeOrigin ||
                  transaction.mapping.map(before.from, -1) !== after.from ||
                  transaction.mapping.map(before.to, 1) !== after.to || changesHiddenContent(transaction, before);
                if (mayChangeHidden && (!oldDoc.cut(0, before.from).eq(newDoc.cut(0, after.from)) ||
                    !oldDoc.cut(before.to).eq(newDoc.cut(after.to)))) return null;
              }
              return position;
            }
            return currentPosition;
          },
        },
      }),
      new Plugin<DecorationSet>({
        key: sectionMarksKey,
        state: {
          init: (_, state) => buildSectionMarks(state),
          apply: (transaction, value, _oldState, newState) =>
            transaction.docChanged || transaction.getMeta(sectionFocusKey)
              ? buildSectionMarks(newState)
              : value,
        },
        props: {
          decorations: (state) => sectionMarksKey.getState(state),
          attributes: (state): Record<string, string> =>
            sectionMarksKey.getState(state) === DecorationSet.empty
              ? {}
              : { class: "section-focused" },
        },
      }),
    ];
  },
});
