import type { Slice, Node } from "@tiptap/pm/model";
import { PluginKey, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { clozeCardId } from "./card-id.ts";
import { changedRanges, clozeIdsOf, extractCards, isCardBlock, parseBlock, validatedClozeGroups, type Range } from "./cards.ts";

export type CardTransfer = { op: string; from: string; to: string };
export type WithCardTransfers = (moves: CardTransfer[], dispatch: () => void) => void;

type Cloze = {
  block: Node;
  pos: number;
  localId: string;
  content: string;
};

// Selections and inserted ranges count only complete clozes, braces included.
function clozesIn(doc: Node, ranges: Range[]): Cloze[] {
  const clozes: Cloze[] = [];
  doc.descendants((block, pos) => {
    if (!isCardBlock(block)) return true;
    const start = pos + 1;
    const syntax = parseBlock(block);
    const contains = (from: number, to: number) => ranges.some(range => range.from <= start + from && range.to >= start + to);
    if (block.type.spec.code && syntax.cards.length && contains(0, block.content.size)) {
      clozes.push({ block, pos, localId: "math", content: JSON.stringify(block.content.toJSON()) });
    } else {
      const ids = clozeIdsOf(block, syntax);
      for (const { open, inner, close } of syntax.clozes) {
        const entry = ids.find(id => id.from === inner.from && id.to === inner.to);
        if (entry && contains(open.from, close.to)) {
          clozes.push({ block, pos, localId: entry.id, content: JSON.stringify(block.content.cut(open.from, close.to).toJSON()) });
        }
      }
    }
    return false;
  });
  return clozes;
}

type Cut = {
  token: string;
  text: string;
  content: string[];
  cards: { id: string; members: number[] }[];
};

type Paste = { cut: Cut; inserted: Range[]; moves: CardTransfer[] };
export const clozeCutKey = new PluginKey<ReadonlyMap<string, ReadonlySet<string>>>("clozeCut");
export const clozePasteKey = new PluginKey<Paste>("clozePaste");
const cutAttribute = "data-memnoter-cloze-cut";
// The clipboard proves which cut was pasted. The claim lives in this session.
let latestCut: Cut | undefined;

function clipboardCut(html: string) {
  const cut = latestCut;
  return cut && html.includes(`${cutAttribute}="${cut.token}"`) ? cut : undefined;
}

export function consumePlainClozeCut(html: string, text: string) {
  if (clipboardCut(html) || (!html && latestCut?.text === text.replace(/\r\n/g, "\n"))) {
    latestCut = undefined;
  }
}

export function clozeClipboard(withTransfers: WithCardTransfers = (_moves, dispatch) => dispatch()) {
  return {
    copy(view: EditorView) {
      if (!view.state.selection.empty) latestCut = undefined;
      return false;
    },
    cut(view: EditorView, event: ClipboardEvent) {
      if (!view.editable || !event.clipboardData || view.state.selection.empty) return false;
      latestCut = undefined;
      const { doc, selection } = view.state;
      const clozes = clozesIn(doc, [{ from: selection.from, to: selection.to }]);
      if (!clozes.length) return false;

      const removed = new Map<string, Set<string>>();
      for (const { block, localId } of clozes) {
        const id = block.attrs.cardId;
        if (typeof id !== "string") continue;
        let ids = removed.get(id);
        if (!ids) removed.set(id, ids = new Set());
        ids.add(localId);
      }
      const active = new Set(extractCards(doc).filter(card => card.kind === "cloze").map(card => card.id));
      const cards: Cut["cards"] = [];
      for (const [index, { block, pos, localId }] of clozes.entries()) {
        if (typeof block.attrs.cardId !== "string") continue;
        const id = clozeCardId(block.attrs.cardId, localId);
        if (!active.has(id)) continue;
        const group = validatedClozeGroups(block.attrs.clozeGroups).find(group => group.includes(localId));
        const members = group
          ? group.map(member => clozes.findIndex(cloze => cloze.pos === pos && cloze.localId === member))
          : [index];
        if (members.every(member => member >= 0)) cards.push({ id, members });
      }

      const tr = view.state.tr.deleteSelection();
      if (!tr.docChanged) return false;
      tr.doc.descendants((block, pos) => {
        if (!removed.has(block.attrs.cardId) || block.content.size) return;
        tr.setNodeAttribute(pos, "cardId", null);
        tr.setNodeAttribute(pos, "clozeIds", null);
        tr.setNodeAttribute(pos, "clozeGroups", null);
      });
      const token = crypto.randomUUID();
      const { dom, text } = view.serializeForClipboard(selection.content());
      if (!dom.firstElementChild) return false;
      dom.firstElementChild.setAttribute(cutAttribute, token);
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", dom.innerHTML);
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      const history = yUndoPluginKey.getState(view.state)?.undoManager;
      history?.stopCapturing();
      view.dispatch(tr.setMeta(clozeCutKey, removed).setMeta("uiEvent", "cut").scrollIntoView());
      history?.stopCapturing();
      latestCut = { token, text, content: clozes.map(cloze => cloze.content), cards };
      return true;
    },
    paste(view: EditorView, event: ClipboardEvent, slice: Slice) {
      const cut = clipboardCut(event.clipboardData?.getData("text/html") ?? "");
      if (!cut) {
        const data = event.clipboardData;
        if (data && !data.getData("text/html")) consumePlainClozeCut("", data.getData("text/plain"));
        return false;
      }
      if (!slice.size || view.state.selection.$from.parent.type.spec.code) {
        latestCut = undefined;
        return false;
      }
      const tr = view.state.tr.replaceSelection(slice);
      if (!tr.docChanged) return false;
      const present = new Set(extractCards(view.state.doc).map(card => card.id));
      const moves: CardTransfer[] = [];
      const paste: Paste = {
        cut: { ...cut, cards: cut.cards.filter(card => !present.has(card.id)) },
        inserted: changedRanges(tr.mapping.maps),
        moves,
      };
      latestCut = undefined;
      const history = yUndoPluginKey.getState(view.state)?.undoManager;
      history?.stopCapturing();
      tr.setMeta(clozePasteKey, paste).setMeta("paste", true).setMeta("uiEvent", "paste");
      withTransfers(moves, () => view.dispatch(tr.scrollIntoView()));
      history?.stopCapturing();
      return true;
    },
  };
}

// The paste has been fitted into the document and normal id repair has run.
// Renew only the clozes inside the insertion, leaving destination siblings
// (including identical answers) with the ids their anchors retained.
export function assignPastedClozes(tr: Transaction, { cut, inserted, moves }: Paste) {
  const clozes = clozesIn(tr.doc, inserted);
  const matches = clozes.length === cut.content.length;
  const newIds = clozes.map(cloze => cloze.block.type.spec.code ? "math" : `c${crypto.randomUUID()}`);
  const groupsByPos = new Map<number, string[][]>();
  const targets = new Map<string, string>();
  for (const { id, members } of cut.cards) {
    const first = clozes[members[0]];
    if (!matches || !first || !members.every(index => clozes[index].pos === first.pos &&
      clozes[index].content === cut.content[index])) continue;
    const group = members.map(index => newIds[index]);
    if (group.length > 1) {
      let groups = groupsByPos.get(first.pos);
      if (!groups) groupsByPos.set(first.pos, groups = []);
      groups.push(group);
    }
    if (typeof first.block.attrs.cardId === "string") {
      targets.set(id, clozeCardId(first.block.attrs.cardId, group[0]));
    }
  }

  const blocks = new Map<number, [number, Cloze][]>();
  for (const [index, cloze] of clozes.entries()) {
    let entries = blocks.get(cloze.pos);
    if (!entries) blocks.set(cloze.pos, entries = []);
    entries.push([index, cloze]);
  }
  for (const [pos, entries] of blocks) {
    const block = entries[0][1].block;
    if (block.type.spec.code) continue;
    const replaced = new Map(entries.map(([index, cloze]) => [cloze.localId, newIds[index]]));
    tr.setNodeAttribute(pos, "clozeIds", clozeIdsOf(block).map(entry => ({
      ...entry, id: replaced.get(entry.id) ?? entry.id,
    })));
    const claimed = new Set((groupsByPos.get(pos) ?? []).flat());
    const groups = validatedClozeGroups(block.attrs.clozeGroups)
      .map(group => group.map(id => replaced.get(id) ?? id).filter(id => !claimed.has(id)))
      .filter(group => group.length > 1);
    groups.push(...groupsByPos.get(pos) ?? []);
    if (groups.length || block.attrs.clozeGroups) tr.setNodeAttribute(pos, "clozeGroups", groups.length ? groups : null);
  }

  if (!targets.size) return;
  const active = new Set(extractCards(tr.doc).map(card => card.id));
  for (const [from, to] of targets) {
    if (active.has(to)) moves.push({ op: crypto.randomUUID(), from, to });
  }
}

// In HTML paste, never import the block id of a cloze. Copy, a spent cut and
// clipboard data from a previous launch all go through this same path.
export function renewClipboardClozeBlock(node: Node) {
  return isCardBlock(node) && (node.attrs.clozeIds !== null || parseBlock(node).cards.some(card => card.kind === "cloze"))
    ? node.type.create({ ...node.attrs, cardId: null }, node.content, node.marks)
    : node;
}
