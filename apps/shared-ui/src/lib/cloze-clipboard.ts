import { Fragment, Slice, type Node } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { cardGroupsOf, clozeNotesOf, extractCards, isCardBlock, parseBlock, validatedClozeIds, validatedClozeNote } from "./cards";

export const literalPasteMeta = "literal-paste";

export function mapClipboardNodes(fragment: Fragment, map: (node: Node) => Node): Fragment {
  const nodes: Node[] = [];
  fragment.forEach(node => nodes.push(map(node.copy(mapClipboardNodes(node.content, map)))));
  return Fragment.fromArray(nodes);
}

export function hasClozeIdentity(node: Node) {
  return isCardBlock(node) && typeof node.attrs.cardId === "string" &&
    (validatedClozeIds(node.attrs.clozeIds) !== null || parseBlock(node).cards.some(card => card.kind === "cloze"));
}

function writeClipboard(view: EditorView, event: ClipboardEvent, slice: Slice, token?: string) {
  const data = event.clipboardData;
  if (!data) return null;
  const { dom, text } = view.serializeForClipboard(slice);
  if (token) {
    if (!dom.firstElementChild) return null;
    dom.firstElementChild.setAttribute(cutAttribute, token);
  }
  data.clearData();
  data.setData("text/html", dom.innerHTML);
  data.setData("text/plain", text);
  event.preventDefault();
  return { text };
}

export type CutClozeOptions = {
  moduleId: string;
  onError: (error: unknown) => void;
};

type Cut = {
  token: string;
  text: string;
  // What the editor will insert, to compare against the parsed clipboard.
  content: string;
  source: string;
  cardIds: readonly string[];
  blockIds: ReadonlySet<string>;
};

// The clipboard carries a nonce. Only this session can claim the original ids.
let latestCut: Cut | undefined;
// A spent cut still pastes as whole blocks, so it never splits a card.
let lastCut: Cut | undefined;
const cutAttribute = "data-memnoter-cloze-cut";

function hasCutToken(cut: Cut, html: string) {
  return html.includes(`${cutAttribute}="${cut.token}"`);
}

function matchesPlainCut(cut: Cut, text: string) {
  return !!cut.text && text.replace(/\r\n/g, "\n") === cut.text;
}

// Chromium exposes only text/plain for Paste as Plain Text. Text can spend
// a claim, but only the nonce in HTML can transfer history.
export function consumePlainClozeCut(html: string, text: string) {
  const cut = latestCut;
  if (cut && (html ? hasCutToken(cut, html) : matchesPlainCut(cut, text))) {
    latestCut = undefined;
  }
}

type Paste = { cut: Cut; claim: boolean };

export function clozeClipboard(options: CutClozeOptions) {
  let paste: Paste | undefined;

  return {
    copy(view: EditorView, event: ClipboardEvent) {
      if (!event.clipboardData || view.state.selection.empty) return false;
      const slice = view.state.selection.content();
      const content = mapClipboardNodes(slice.content, node => hasClozeIdentity(node)
        ? node.type.create({ ...node.attrs, cardId: null }, node.content, node.marks)
        : node);
      if (content.eq(slice.content)) return false;
      return !!writeClipboard(view, event, new Slice(content, slice.openStart, slice.openEnd));
    },

    cut(view: EditorView, event: ClipboardEvent) {
      if (!view.editable || !event.clipboardData || view.state.selection.empty) return false;
      const { doc, selection } = view.state;
      const { from, to } = selection;
      // Selecting all of a paragraph's text counts even when ProseMirror
      // leaves its empty shell behind. A clipped block never lends its id.
      const wholeBlocks = new Set<string>();
      doc.nodesBetween(from, to, (node, pos) => {
        if (hasClozeIdentity(node) && from <= pos + 1 && to >= pos + node.nodeSize - 1) {
          wholeBlocks.add(node.attrs.cardId);
        }
      });
      if (!wholeBlocks.size) return false;

      const moved = extractCards(doc).filter(card => card.kind === "cloze" && wholeBlocks.has(card.blockId));
      if (!moved.length) return false;
      const blockIds = new Set(moved.map(card => card.blockId));
      // An emptied block keeps its id, so cards another device types into it
      // meanwhile keep theirs. The paste takes the id back only if it is unused.
      const tr = view.state.tr.deleteSelection();
      const token = crypto.randomUUID();
      const clipboard = writeClipboard(view, event, selection.content(), token);
      if (!clipboard) return false;

      const history = yUndoPluginKey.getState(view.state)?.undoManager;
      history?.stopCapturing();
      view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "cut"));
      history?.stopCapturing();
      const cutContent = selection.content().content;
      latestCut = lastCut = { token, text: clipboard.text, content: cutContent.textBetween(0, cutContent.size, "\n"), source: options.moduleId, cardIds: moved.map(card => card.id), blockIds };
      return true;
    },

    startPaste(view: EditorView, event: ClipboardEvent) {
      const cut = lastCut;
      const data = event.clipboardData;
      if (!cut || !data || !view.editable || view.composing) return false;
      const html = data.getData("text/html");
      if (!html) {
        if (cut === latestCut && matchesPlainCut(cut, data.getData("text/plain"))) latestCut = undefined;
        return false;
      }
      if (!hasCutToken(cut, html)) return false;
      paste = { cut, claim: cut === latestCut };
      queueMicrotask(() => { paste = undefined; });
      return false;
    },

    // ProseMirror pastes rich HTML as text only inside code and math. That
    // edits the formula like any paste, but it never spends the claim.
    blocksForPaste(plain: boolean) {
      if (plain) paste = undefined;
      return paste?.cut.blockIds;
    },

    handlePaste(view: EditorView, _event: ClipboardEvent, slice: Slice) {
      const current = paste;
      if (!current) return false;
      paste = undefined;
      // The marker proves the cut came from this session; the parsed content
      // proves the clipboard still holds what was cut.
      const { cut } = current;
      const claim = current.claim && slice.content.textBetween(0, slice.content.size, "\n") === cut.content;

      const { state } = view;
      const { from, to, $from } = state.selection;
      let insertAt: number | undefined;
      const protect = (node: Node, pos: number) => {
        if (isCardBlock(node) && parseBlock(node).cards.length) insertAt = pos + node.nodeSize;
      };
      // Anything pasted inside a grouped card joins it, so go before its opener.
      const group = cardGroupsOf(state.doc).find(group => from < group.to && to > group.from);
      if (group) insertAt = group.from;
      else if (from === to && $from.depth) protect($from.parent, $from.before());
      else state.doc.nodesBetween(from, to, protect);

      const sameNote = cut.source === options.moduleId;
      const present = new Set(extractCards(state.doc).map(card => card.id));
      const adjacentNotes = sameNote
        ? clozeNotesOf(state.doc).filter(note => note.from <= (insertAt ?? to) && note.to >= (insertAt ?? from))
        : [];
      const openStart = clozePasteDepth(slice.content.firstChild, slice.openStart, cut.blockIds, "firstChild");
      const openEnd = clozePasteDepth(slice.content.lastChild, slice.openEnd, cut.blockIds, "lastChild");
      const notes = remapClozeNotes(slice.content, id => adjacentNotes.some(note => note.id === id));
      const build = (keepHistory: boolean) => {
        const content = keepHistory ? notes : mapClipboardNodes(notes, node => cut.blockIds.has(node.attrs.cardId)
          ? node.type.create({ ...node.attrs, cardId: crypto.randomUUID() }, node.content, node.marks)
          : node);
        const tr = state.tr;
        // The emptied source block still holds the id. With no cards left in
        // it, the paste takes the id back.
        if (keepHistory) state.doc.descendants((node, pos) => {
          if (!cut.blockIds.has(node.attrs.cardId) || parseBlock(node).cards.length) return;
          tr.setNodeAttribute(pos, "cardId", null);
          tr.setNodeAttribute(pos, "clozeIds", null);
          tr.setNodeAttribute(pos, "clozeGroups", null);
        });
        const pasted = new Slice(content, openStart, openEnd);
        if (insertAt === undefined) {
          tr.replaceSelection(pasted);
        } else {
          tr.replaceRange(insertAt, insertAt, pasted);
          if (tr.docChanged) tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(insertAt)), -1));
        }
        if (!keepHistory) return tr;
        const inserted = new Set(extractCards(tr.doc).map(card => card.id));
        return cut.cardIds.every(id => inserted.has(id)) ? tr : null;
      };
      // Undo may have restored the original, or new cards may now use its
      // block id. Then the paste is a new card, like a copy.
      const canKeep = claim && sameNote && !cut.cardIds.some(id => present.has(id));
      const tr = (canKeep && build(true)) || build(false)!;
      if (!tr.docChanged) {
        options.onError(new Error("The cut card does not fit here. Choose a different paste location."));
        return true;
      }

      const history = yUndoPluginKey.getState(state)?.undoManager;
      if (claim) latestCut = undefined;
      history?.stopCapturing();
      view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "paste"));
      history?.stopCapturing();
      return true;
    },
  };
}

function remapClozeNotes(content: Fragment, keep: (id: string) => boolean = () => false) {
  const notes = new Map<string, string>();
  return mapClipboardNodes(content, node => {
    const note = validatedClozeNote(node.attrs.clozeNote);
    if (!note || keep(note)) return node;
    let id = notes.get(note);
    if (!id) {
      id = crypto.randomUUID();
      notes.set(note, id);
    }
    return node.type.create({ ...node.attrs, clozeNote: id }, node.content, node.marks);
  });
}

// Open textblock edges would merge into the destination and lose their attrs.
function clozePasteDepth(node: Node | null, depth: number, blocks: ReadonlySet<string>, edge: "firstChild" | "lastChild") {
  for (let level = 0; node && level < depth; level++, node = node[edge]) {
    if (blocks.has(node.attrs.cardId)) return level;
  }
  return depth;
}
