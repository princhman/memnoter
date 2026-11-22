import * as Y from "yjs";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { TextSelection } from "@tiptap/pm/state";
import { call } from "./backend";
import type { ContentUpdate } from "./content";
import { isNoteFromNewerVersion } from "./editor-schema";
import { loadStoredNote } from "./note-index";
import { outline, TOC_ID_ATTRIBUTE } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { assertWritable, writeOperation } from "./write-lifecycle";
import { flushSaves } from "./saves";
import { onRemote } from "./sync/apply-remote";

export type SectionReorder = { moduleId: string; headingId: string; anchorId: string; edge: "before" | "after" };

function reorderOpen(editor: Editor, { headingId, anchorId, edge }: SectionReorder) {
  assertWritable();
  const headings = outline(editor.state.doc);
  const section = headings.find(item => item.id === headingId && item.level === 1);
  const anchor = headings.find(item => item.id === anchorId && item.level === 1);
  if (!section || !anchor) throw new Error("This section changed. Please drag it again.");
  const at = edge === "before" ? anchor.pos : anchor.end;
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

export async function reorderSidebarSection(
  move: SectionReorder, active: { moduleId: string; editor: Editor; isReady: boolean } | null,
) {
  const { moduleId, headingId, anchorId, edge } = move;
  if (active?.moduleId === moduleId && !active.editor.isDestroyed) {
    if (!active.isReady || !active.editor.isEditable) throw new Error("This note is read-only.");
    reorderOpen(active.editor, move);
    if (!await flushSaves()) throw new Error("The new order is waiting to save. Please retry saving before closing.");
    return;
  }

  // Persist through the ordinary single-document update and sync outbox.
  // Track the operation so navigation and database replacement wait for it.
  await writeOperation(async () => {
    if (!await flushSaves()) throw new Error("Pending edits could not be saved. Please retry saving first.");
    const doc = await loadStoredNote(moduleId);
    try {
      if (doc.store.pendingStructs || doc.store.pendingDs || isNoteFromNewerVersion(doc)) {
        throw new Error("This note cannot be safely edited by this version.");
      }
      const root = doc.getXmlFragment("default");
      const sections = root.toArray().flatMap((node, index) =>
        node instanceof Y.XmlElement && node.nodeName === "heading" && Number(node.getAttribute("level")) === 1
          ? [{ id: node.getAttribute(TOC_ID_ATTRIBUTE), index }]
          : []);
      const source = sections.findIndex(section => section.id === headingId);
      const anchor = sections.findIndex(section => section.id === anchorId);
      if (source < 0 || anchor < 0) throw new Error("This section changed. Please drag it again.");

      const start = sections[source].index;
      const end = sections[source + 1]?.index ?? root.length;
      const at = edge === "before" ? sections[anchor].index : sections[anchor + 1]?.index ?? root.length;
      if (at >= start && at <= end) return;

      const before = Y.encodeStateVector(doc);
      const nodes = root.slice(start, end).map(node => node.clone());
      doc.transact(() => {
        root.delete(start, end - start);
        root.insert(at > end ? at - (end - start) : at, nodes);
      });
      const update = await call<ContentUpdate>("add_update", {
        moduleId, bytes: Array.from(Y.encodeStateAsUpdate(doc, before)),
      });
      onRemote({ updates: [{ moduleId, update }], modulesChanged: false, deleted: [], reviewsChanged: false, filesChanged: false });
    } finally { doc.destroy(); }
  });
}
