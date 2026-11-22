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
      const moved = sourceNodes.slice(start, end).map(node => node.clone()) as (Y.XmlElement | Y.XmlText)[];
      const schema = getSchema(noteExtensions({ document: docs[0] }));
      const previousCards = extractCards(schema.nodeFromJSON(yDocToProsemirrorJSON(docs[0], "default")));
      docs[0].transact(() => roots[0].delete(start, end - start));
      if (targetIndex === 0 && at > end) at -= end - start;
      docs[targetIndex].transact(() => targetRoot.insert(at, moved));
      const remaining = new Set(extractCards(schema.nodeFromJSON(yDocToProsemirrorJSON(docs[0], "default"))).map(card => card.id));
      const cardIds = previousCards.filter(card => !remaining.has(card.id)).map(card => card.id);
      const edits = ids.map((moduleId, index) => ({
        moduleId, expectedState: saved[index].state,
        expectedUpdateId: Math.max(0, ...saved[index].updates.map(update => update.id)),
        bytes: Array.from(Y.encodeStateAsUpdate(docs[index], before[index])),
      }));
      const receipts = await call<ContentUpdate[]>("move_note_section", { edits, cardIds });
      // Source history can resurrect transferred content. The recipient's
      // existing history cannot touch the newly inserted Yjs nodes.
      if (active?.moduleId === source.moduleId && !active.editor.isDestroyed) {
        yUndoPluginKey.getState(active.editor.state)?.undoManager.clear();
      }
      for (let i = 0; i < ids.length; i++) {
        appendSavedUpdate(ids[i], receipts[i]);
        queryClient.setQueryData(contentKey(ids[i]), { ...saved[i], updates: [...saved[i].updates, receipts[i]] });
      }
      onRemote({ updates: ids.map((moduleId, i) => ({ moduleId, update: receipts[i] })), modulesChanged: false, deleted: [], reviewsChanged: true, filesChanged: true });
    } finally { docs.forEach(doc => doc.destroy()); }
  }, { kind: "section-move" });
}
