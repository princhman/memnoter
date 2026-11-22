import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { yDocToProsemirrorJSON, yUndoPluginKey } from "@tiptap/y-tiptap";
import { TextSelection } from "@tiptap/pm/state";
import { call } from "./backend";
import { applySavedContent, appendSavedUpdate, contentKey, type ContentUpdate, type GetContentResponse } from "./content";
import { isNoteFromNewerVersion, noteExtensions } from "./editor-schema";
import { extractCards } from "./cards";
import { outline } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { assertWritable, exclusiveWrite } from "./write-lifecycle";
import { queryClient } from "./query-client";
import { flushSaves } from "./saves";
import { onRemote } from "./sync/apply-remote";

export type SectionSource = { moduleId: string; headingId: string };
export type SectionDestination = { moduleId: string; headingId?: string; edge: "before" | "after" | "end" };

function headingIdsIn(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string[] {
  if (!(node instanceof Y.XmlElement)) return [];
  const id = node.nodeName === "heading" ? node.getAttribute("data-toc-id") : undefined;
  return [...(typeof id === "string" && id ? [id] : []), ...node.toArray().flatMap(headingIdsIn)];
}

function forgetSectionUndo(editor: Editor, headingId: string) {
  const manager: Y.UndoManager | undefined = yUndoPluginKey.getState(editor.state)?.undoManager;
  if (!manager) return;
  const root = manager.doc.getXmlFragment("default");
  const section = root.toArray().find(node => node instanceof Y.XmlElement &&
    node.nodeName === "heading" && node.getAttribute("data-toc-id") === headingId);
  if (!section?._item) return;
  const moved = new Set<Y.Item>();
  // Include already-deleted sibling blocks in this range. They still exist
  // in the live undo manager and could otherwise be restored in the source.
  for (let item: Y.Item | null = section._item; item; item = item.right) {
    const [node] = item.content.getContent();
    if (item !== section._item && !item.deleted && node instanceof Y.XmlElement &&
      node.nodeName === "heading" && Number(node.getAttribute("level")) === 1) break;
    moved.add(item);
  }
  const outsideSection = (stack: Y.UndoManager["undoStack"]) => {
    return stack.filter(entry => {
      let touchesSection = false;
      const inspect = (struct: Y.AbstractStruct) => {
        if (!(struct instanceof Y.Item)) return;
        let item = struct;
        while (item.parent instanceof Y.AbstractType && item.parent._item) {
          item = item.parent._item;
        }
        touchesSection ||= moved.has(item);
      };
      manager.doc.transact(transaction => {
        Y.iterateDeletedStructs(transaction, entry.insertions, inspect);
        Y.iterateDeletedStructs(transaction, entry.deletions, inspect);
      });
      return !touchesSection;
    });
  };
  manager.undoStack = outsideSection(manager.undoStack);
  manager.redoStack = outsideSection(manager.redoStack);
  manager.stopCapturing();
}

function reorderOpen(editor: Editor, source: SectionSource, target: SectionDestination) {
  assertWritable();
  const headings = outline(editor.state.doc);
  const section = headings.find(item => item.id === source.headingId && item.level === 1);
  const anchor = headings.find(item => item.id === target.headingId && item.level === 1);
  if (!section || (target.edge !== "end" && !anchor)) throw new Error("This section changed. Please drag it again.");
  const at = target.edge === "end" ? editor.state.doc.content.size : target.edge === "before" ? anchor!.pos : anchor!.end;
  if (at >= section.pos && at <= section.end) return;
  const length = section.end - section.pos;
  const to = at > section.end ? at - length : at;
  const slice = editor.state.doc.slice(section.pos, section.end).content;
  const focusedId = headings.find(item => item.pos === sectionFocusKey.getState(editor.state))?.id;
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  manager?.stopCapturing();
  const tr = editor.state.tr.delete(section.pos, section.end).insert(to, slice);
  tr.setMeta("heading-outline-adjustment", true);
  if (focusedId) {
    const focus = outline(tr.doc).find(item => item.id === focusedId);
    tr.setMeta(sectionFocusKey, focus ? { type: "show", position: focus.pos } : { type: "clear" });
  }
  if (editor.state.selection.from >= section.pos && editor.state.selection.from < section.end) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(to + editor.state.selection.from - section.pos)));
  }
  editor.view.dispatch(tr);
  manager?.stopCapturing();
}

// The live editor has ordinary one-step undo for reordering. Closed-note and
// cross-note edits use disposable Yjs readers and a checked database transaction.
export async function moveSidebarSection(source: SectionSource, target: SectionDestination, active?: { moduleId: string; editor: Editor; isReady: boolean } | null) {
  if (source.moduleId === target.moduleId && active?.moduleId === source.moduleId && active.isReady && !active.editor.isDestroyed) {
    if (!active.editor.isEditable) throw new Error("This note is read-only.");
    reorderOpen(active.editor, source, target);
    if (!await flushSaves()) throw new Error("The new order is waiting to save. Please retry saving before closing.");
    return;
  }
  await exclusiveWrite(async () => {
    const ids = [...new Set([source.moduleId, target.moduleId])];
    const docs: Y.Doc[] = [];
    try {
      const saved = await Promise.all(ids.map(async moduleId => {
        await queryClient.cancelQueries({ queryKey: contentKey(moduleId) });
        return call<GetContentResponse>("get_content", { moduleId });
      }));
      for (const snapshot of saved) {
        const doc = new Y.Doc(); docs.push(doc);
        applySavedContent(doc, snapshot);
        if (doc.store.pendingStructs || doc.store.pendingDs || isNoteFromNewerVersion(doc)) throw new Error("This note cannot be safely moved by this version.");
      }
      const roots = docs.map(doc => doc.getXmlFragment("default"));
      const before = docs.map(doc => Y.encodeStateVector(doc));
      const sourceNodes = roots[0].toArray();
      const isH1 = (node: unknown): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "heading" && Number(node.getAttribute("level")) === 1;
      const start = sourceNodes.findIndex(node => isH1(node) && node.getAttribute("data-toc-id") === source.headingId);
      if (start < 0) throw new Error("The section no longer exists.");
      let end = start + 1;
      while (end < sourceNodes.length && !isH1(sourceNodes[end])) end++;
      const targetIndex = ids.indexOf(target.moduleId);
      const targetRoot = roots[targetIndex];
      const targetNodes = targetRoot.toArray();
      let at = targetNodes.length;
      if (target.edge !== "end") {
        at = targetNodes.findIndex(node => isH1(node) && node.getAttribute("data-toc-id") === target.headingId);
        if (at < 0) throw new Error("The destination section no longer exists.");
        if (target.edge === "after") { at++; while (at < targetNodes.length && !isH1(targetNodes[at])) at++; }
      }
      if (targetIndex === 0 && at >= start && at <= end) return;
      const section = sourceNodes.slice(start, end);
      const moved = section.map(node => node.clone()) as (Y.XmlElement | Y.XmlText)[];
      const headingIds = section.flatMap(headingIdsIn);
      const schema = getSchema(noteExtensions({ document: docs[0] }));
      const previousCards = extractCards(schema.nodeFromJSON(yDocToProsemirrorJSON(docs[0], "default")));
      let cut: number[] | undefined;
      if (targetIndex !== 0) docs[0].once("update", update => { cut = Array.from(update); });
      docs[0].transact(() => roots[0].delete(start, end - start));
      if (targetIndex === 0 && at > end) at -= end - start;
      docs[targetIndex].transact(() => targetRoot.insert(at, moved));
      const remaining = new Set(extractCards(schema.nodeFromJSON(yDocToProsemirrorJSON(docs[0], "default"))).map(card => card.id));
      const cardIds = previousCards.filter(card => !remaining.has(card.id)).map(card => card.id);
      const edits = ids.map((moduleId, index) => ({
        moduleId, expectedState: saved[index].state,
        expectedUpdateId: Math.max(0, ...saved[index].updates.map(update => update.id)),
        bytes: index === 0 && cut ? cut : Array.from(Y.encodeStateAsUpdate(docs[index], before[index])),
      }));
      let restoreSource: number[] | null = null;
      if (targetIndex !== 0) {
        docs[0].once("update", update => { restoreSource = Array.from(update); });
        roots[0].insert(start, moved.map(node => node.clone()));
      }
      const receipts = await call<ContentUpdate[]>("move_note_section", { edits, cardIds, headingIds, restoreSource });
      if (targetIndex !== 0 && active?.moduleId === source.moduleId && !active.editor.isDestroyed) {
        forgetSectionUndo(active.editor, source.headingId);
      }
      for (let i = 0; i < ids.length; i++) {
        appendSavedUpdate(ids[i], receipts[i]);
        queryClient.setQueryData(contentKey(ids[i]), { ...saved[i], updates: [...saved[i].updates, receipts[i]] });
      }
      onRemote({ updates: ids.map((moduleId, i) => ({ moduleId, update: receipts[i] })), modulesChanged: false, deleted: [], reviewsChanged: true, filesChanged: true });
    } finally { docs.forEach(doc => doc.destroy()); }
  }, { kind: "section-move" });
}
