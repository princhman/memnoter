import { headingId, outline } from "./outline.ts";
import { Extension, isiOS, isMacOS } from "@tiptap/core";
import { AllSelection, type EditorState, PluginKey, Plugin, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { StepMap, type Mappable } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/core";
import { ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";
import { XmlElement, type Transaction as YTransaction } from "yjs";
import { backspaceHeading } from "./heading-hierarchy";

export const sectionFocusKey = new PluginKey<number | null>("section-focus");

type SectionRange = { from: number; to: number };

export function sectionContainsRange(section: SectionRange, target: SectionRange) {
  return target.from >= section.from && target.to <= section.to;
}

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
): SectionRange | null {
  return getSectionRange(state.doc, sectionFocusKey.getState(state));
}

// A heading and everything up to the next heading at its level or higher.
export function getSectionRange(
  doc: EditorState["doc"],
  headingPos: unknown,
): SectionRange | null {
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

function nativeSelectionCrossesBoundary(view: EditorView, range: { from: number; to: number }) {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return false;
  const containsAnchor = view.dom.contains(selection.anchorNode);
  const containsHead = view.dom.contains(selection.focusNode);
  if (!containsAnchor || !containsHead) return containsAnchor || containsHead;
  const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
  return Math.min(anchor, head) < range.from || Math.max(anchor, head) > range.to ||
    (anchor === head && (head === range.from || head === range.to));
}

function blockInputOverHiddenSelection(view: EditorView, event: Event) {
  const range = getFocusedSectionRange(view.state);
  if (!range || !nativeSelectionCrossesBoundary(view, range)) return false;
  event.preventDefault();
  return true;
}

function deletesAcrossBoundary(state: EditorState, direction: -1 | 1) {
  const range = getFocusedSectionRange(state);
  if (!range) return false;
  const { empty, $head } = state.selection;
  const edge = direction === 1 ? range.to : range.from;
  const documentEdge = direction === 1 ? state.doc.content.size : 0;
  // A caret inside the last list item has a closing token for each ancestor.
  return empty && edge !== documentEdge &&
    ($head.pos === edge || $head.pos + direction * $head.depth === edge);
}

export function changesHiddenContent(transaction: Transaction, range: SectionRange) {
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

// Inserting at the opening boundary can leave the original heading in
// place and add a block before it, which belongs to the previous section.
function insertsBeforeFocusedHeading(transaction: Transaction, range: SectionRange) {
  const start = transaction.mapping.map(range.from, -1);
  const heading = transaction.mapping.mapResult(range.from, 1);
  if (heading.deleted || heading.pos <= start) return false;
  const $heading = transaction.doc.resolve(heading.pos);
  return $heading.depth === 0 && $heading.nodeAfter?.type.name === "heading";
}

export function changesOutsideSection(transaction: Transaction, range: SectionRange) {
  return changesHiddenContent(transaction, range) || insertsBeforeFocusedHeading(transaction, range);
}

const editorInputEvents = [
  "keydown", "keypress", "beforeinput", "input",
  "compositionstart", "compositionupdate", "compositionend", "cut", "paste", "drop",
];
const directInput = "section-focus-direct-input";
const editorInput = new WeakMap<EditorView, ReturnType<typeof trackEditorInput>>();

function trackEditorInput(view: EditorView, deferringComposition: () => boolean) {
  let events: Event[] = [];
  const dispatching = (event: Event) => event.eventPhase !== Event.NONE;
  const capture = (event: Event) => {
    events = events.filter(dispatching);
    events.push(event);
  };
  for (const type of editorInputEvents) view.dom.addEventListener(type, capture, true);

  let readingDOM = false;
  let discardingDOM = false;
  let dispatchingInput = false;
  const observer = "domObserver" in view ? view.domObserver : null;
  let discardDOM = () => {};
  let restoreObserver = () => {};
  // PM can read input after its DOM event has ended. Scope provenance to the
  // observer callback. For a full section composition, let native preedit run
  // in the DOM and repaint it from editor state before committing the text.
  if (observer && typeof observer === "object" && "flush" in observer &&
      typeof observer.flush === "function" && "handleDOMChange" in observer &&
      typeof observer.handleDOMChange === "function") {
    const { flush, handleDOMChange } = observer;
    observer.flush = () => { if (!deferringComposition()) flush.call(observer); };
    observer.handleDOMChange = (...args: unknown[]) => {
      if (discardingDOM) return;
      const wasReading = readingDOM;
      readingDOM = true;
      try { handleDOMChange.apply(observer, args); }
      finally { readingDOM = wasReading; }
    };
    discardDOM = () => {
      discardingDOM = true;
      try {
        if ("forceFlush" in observer && typeof observer.forceFlush === "function") observer.forceFlush();
        flush.call(observer);
      } finally { discardingDOM = false; }
    };
    restoreObserver = () => {
      observer.flush = flush;
      observer.handleDOMChange = handleDOMChange;
    };
  }

  return {
    discardDOM,
    dispatch(transaction: Transaction, next: (tr: Transaction) => void) {
      if (!transaction.docChanged || dispatchingInput || !(readingDOM || events.some(dispatching)) ||
          transaction.getMeta(ySyncPluginKey) || transaction.getMeta(sectionFocusBackground) ||
          isHistoryTransaction(transaction)) {
        next(transaction);
        return;
      }
      dispatchingInput = true;
      try { next(transaction.setMeta(directInput, true)); }
      finally { dispatchingInput = false; }
    },
    destroy() {
      for (const type of editorInputEvents) view.dom.removeEventListener(type, capture, true);
      restoreObserver();
    },
  };
}

// Text selections need inline endpoints. A section ending in a block atom
// needs a selection whose endpoint can sit after that atom at the document level.
export class SectionSelection extends Selection {
  eq(other: Selection) {
    return other instanceof SectionSelection && this.anchor === other.anchor && this.head === other.head;
  }

  map(doc: EditorState["doc"], mapping: Mappable): Selection {
    const direction = this.anchor < this.head ? 1 : -1;
    const anchor = mapping.map(this.anchor, direction);
    const head = mapping.map(this.head, -direction);
    return (head - anchor) * direction > 0
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

function selectionInSection(state: EditorState, range: { from: number; to: number }, entering: boolean) {
  const { doc, selection } = state;
  if (!(selection instanceof AllSelection) && sectionContainsRange(range, selection) &&
      (!selection.empty || (selection.from > range.from && selection.to < range.to))) return selection;

  const $start = doc.resolve(range.from + 1);
  const $boundary = doc.resolve(range.to);
  if (selection instanceof AllSelection) {
    const end = Selection.findFrom($boundary, -1);
    return end instanceof TextSelection
      ? TextSelection.create(doc, $start.pos, end.to)
      : new SectionSelection(doc.resolve(range.from), $boundary);
  }
  if (selection.to <= range.from || (entering && selection.from >= range.to)) {
    return new TextSelection($start);
  }
  if (selection.from >= range.to) {
    return Selection.findFrom($boundary, -1, true) ?? new TextSelection($start);
  }

  const from = Math.max(selection.from, $start.pos);
  const end = selection.to >= range.to ? Selection.findFrom($boundary, -1) : null;
  const to = end instanceof TextSelection ? end.to : Math.min(selection.to, range.to);
  const forward = selection.anchor <= selection.head;
  const $anchor = doc.resolve(forward ? from : to);
  const $head = doc.resolve(forward ? to : from);
  return $anchor.parent.inlineContent && $head.parent.inlineContent
    ? new TextSelection($anchor, $head)
    : new SectionSelection($anchor, $head);
}

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
        backspaceHeading(this.editor);
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
  dispatchTransaction({ transaction, next }) {
    const input = editorInput.get(this.editor.view);
    if (input) input.dispatch(transaction, next);
    else next(transaction);
  },
  addProseMirrorPlugins() {
    let syncedHeading: XmlElement | null = null;
    let composingSelection: SectionSelection | null = null;
    const finishComposition = (view: EditorView, text: string) => {
      const selection = composingSelection;
      composingSelection = null;
      editorInput.get(view)?.discardDOM();
      const { state } = view;
      if (selection?.$anchor.doc !== state.doc || !selection.eq(state.selection)) return;
      if (text) view.dispatch(state.tr.insertText(text).scrollIntoView());
      else if (view.hasFocus()) view.focus();
    };
    return [
      new Plugin<number | null>({
        key: sectionFocusKey,
        view(view) {
          const input = trackEditorInput(view, () => composingSelection !== null);
          editorInput.set(view, input);
          const binding: unknown = ySyncPluginKey.getState(view.state)?.binding;

          // Capture the item while PM still reflects the pre-sync fragment.
          // Local PM writes already have their own transaction mapping.
          const capture = (transaction: YTransaction) => {
            const { state } = view;
            const pos = sectionFocusKey.getState(state);
            if (!(binding instanceof ProsemirrorBinding) || pos == null || transaction.origin === ySyncPluginKey ||
                binding.type.length !== state.doc.childCount) return;
            const item = binding.type.get(state.doc.resolve(pos).index());
            if (item instanceof XmlElement) syncedHeading = item;
          };
          const clear = () => { syncedHeading = null; };
          if (binding instanceof ProsemirrorBinding) {
            binding.doc.on("beforeTransaction", capture);
            binding.doc.on("afterAllTransactions", clear);
          }
          return {
            update(view) {
              if (composingSelection) {
                if (composingSelection.$anchor.doc !== view.state.doc || !composingSelection.eq(view.state.selection)) {
                  finishComposition(view, "");
                }
                return;
              }
              // If clamping returns the previous PM selection, PM may leave an
              // escaped native range in place (e.g. Shift+Arrow at the edge).
              const range = getFocusedSectionRange(view.state);
              if (range && !view.composing && view.hasFocus() && nativeSelectionCrossesBoundary(view, range)) {
                view.focus();
              }
            },
            destroy() {
              input.destroy();
              editorInput.delete(view);
              composingSelection = null;
              if (!(binding instanceof ProsemirrorBinding)) return;
              binding.doc.off("beforeTransaction", capture);
              binding.doc.off("afterAllTransactions", clear);
            },
          };
        },
        props: {
          handleDOMEvents: {
            keydown(view, event) {
              if (!view.composing && !event.isComposing) return false;
              if (event.key === "Delete" && deletesAcrossBoundary(view.state, 1) ||
                  event.key === "Backspace" && deletesAcrossBoundary(view.state, -1)) {
                event.preventDefault();
                return true;
              }
              return blockInputOverHiddenSelection(view, event);
            },
            beforeinput(view, event) {
              const range = getFocusedSectionRange(view.state);
              if (!range) return false;

              const outside = event.getTargetRanges?.().some(({ startContainer, startOffset, endContainer, endOffset }) => {
                if (!view.dom.contains(startContainer) || !view.dom.contains(endContainer)) return true;
                const from = view.posAtDOM(startContainer, startOffset);
                const to = view.posAtDOM(endContainer, endOffset);
                return !sectionContainsRange(range, { from, to }) ||
                  (from === to && (from === range.from || from === range.to));
              });
              const { inputType } = event;
              const deleting = inputType.startsWith("delete");
              const externalInsert = inputType === "insertFromPaste" || inputType === "insertFromDrop";
              const boundaryDelete = inputType.endsWith("Forward") && deletesAcrossBoundary(view.state, 1) ||
                inputType.endsWith("Backward") && deletesAcrossBoundary(view.state, -1);
              const replaceSection = (inputType === "insertReplacementText" || inputType === "insertText") && view.editable &&
                !composingSelection &&
                !view.composing && !event.isComposing && view.state.selection instanceof SectionSelection;
              if (outside || boundaryDelete ||
                  ((deleting || externalInsert || event.isComposing || replaceSection) &&
                    nativeSelectionCrossesBoundary(view, range))) {
                event.preventDefault();
                return true;
              }
              if (replaceSection && event.cancelable) {
                const text = event.data ?? (event.dataTransfer?.getData("text/plain") || null);
                if (text != null) {
                  // The native replacement range can omit a selected block atom.
                  event.preventDefault();
                  view.dispatch(view.state.tr.insertText(text).scrollIntoView());
                  return true;
                }
              }
              return false;
            },
            // Composition start can delete a spanning selection before
            // ProseMirror starts tagging its transactions as composition.
            compositionstart(view, event) {
              if (blockInputOverHiddenSelection(view, event)) return true;
              const { selection } = view.state;
              if (!view.editable || view.composing || !getFocusedSectionRange(view.state) ||
                  !(selection instanceof SectionSelection)) return false;
              // Keep the browser's preedit in one text block. The PM selection
              // still includes the whole section until the committed text arrives.
              const caret = Selection.findFrom(selection.$from, 1, true);
              const native = view.dom.ownerDocument.getSelection();
              if (!caret || caret.from >= selection.to || !native) return false;
              const { node, offset } = view.domAtPos(caret.from, 1);
              composingSelection = selection;
              native.collapse(node, offset);
              return true;
            },
            compositionupdate(view, event) {
              return blockInputOverHiddenSelection(view, event) || composingSelection !== null;
            },
            compositionend(view, event) {
              if (!composingSelection) return false;
              finishComposition(view, event.data);
              return true;
            },
            blur(view) {
              if (composingSelection) finishComposition(view, "");
              return false;
            },
            cut: blockInputOverHiddenSelection,
            paste: blockInputOverHiddenSelection,
            drop(view, event) {
              const range = getFocusedSectionRange(view.state);
              if (!range) return false;
              const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!target || (target.pos >= range.from && target.pos <= range.to)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
        filterTransaction(transaction, state) {
          if (!transaction.getMeta(directInput)) return true;
          const range = getFocusedSectionRange(state);
          return !range || !changesOutsideSection(transaction, range);
        },
        appendTransaction(transactions, oldState, state) {
          // Clamp the final selection for every route, including selections
          // mapped through a document edit, before the view can accept input.
          const range = getFocusedSectionRange(state);
          if (!range) return null;
          const source = transactions[0];
          const sync = source.getMeta(ySyncPluginKey);
          const previous = oldState.selection;
          const before = previous instanceof SectionSelection ? getFocusedSectionRange(oldState) : null;
          // Yjs restores text endpoints, which cannot sit after a block atom.
          const restoreSection = sync?.isChangeOrigin && !sync.isUndoRedoOperation &&
            before && previous.from === before.from && previous.to === before.to;
          const selection = restoreSection
            ? new SectionSelection(state.doc.resolve(range.from), state.doc.resolve(range.to))
            : selectionInSection(state, range, transactions.some(tr => tr.getMeta(sectionFocusKey)?.type === "show"));
          if (selection.eq(state.selection)) return null;

          const tr = state.tr.setSelection(selection);
          if (transactions[transactions.length - 1].getMeta("addToHistory") === false) tr.setMeta("addToHistory", false);
          return tr;
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
