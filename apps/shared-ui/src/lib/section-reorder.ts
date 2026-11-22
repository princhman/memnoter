import type { Editor } from "@tiptap/core";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { Selection } from "@tiptap/pm/state";
import { outline } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { assertWritable } from "./write-lifecycle";
import { flushSaves } from "./saves";

export type SectionReorder = { moduleId: string; headingId: string; anchorId: string; edge: "before" | "after" };

function reorderOpen(editor: Editor, { headingId, anchorId, edge }: SectionReorder) {
  assertWritable();
  const headings = outline(editor.state.doc);
  const section = headings.find(item => item.id === headingId && item.level === 1);
  const anchor = headings.find(item => item.id === anchorId && item.level === 1);
  if (!section || !anchor) throw new Error("This section changed. Please drag it again.");
  const at = edge === "before" ? anchor.pos : anchor.end;
  if (at >= section.pos && at <= section.end) return;
  const { doc, selection } = editor.state;
  const fragment = ySyncPluginKey.getState(editor.state)?.type;
  if (!(fragment instanceof Y.XmlFragment) || !fragment.doc || fragment.length !== doc.childCount) {
    throw new Error("This section changed. Please drag it again.");
  }
  const first = doc.resolve(section.pos).index();
  const end = doc.resolve(section.end).index();
  const target = doc.resolve(at).index();
  const copies = fragment.slice(first, end).map(block => block.clone());
  const focusedPos = sectionFocusKey.getState(editor.state);
  const inSection = (pos: number) => pos >= section.pos && pos < section.end;
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;

  // Let the binding render the Yjs move. A ProseMirror replacement can reuse
  // the drop target's Yjs items, redirecting concurrent edits to the wrong block.
  manager?.stopCapturing();
  fragment.doc.transact(() => {
    fragment.delete(first, end - first);
    fragment.insert(target > end ? target - (end - first) : target, copies);
  }, ySyncPluginKey);
  manager?.stopCapturing();

  const to = at > section.end ? at - (section.end - section.pos) : at;
  const tr = editor.state.tr;
  if (focusedPos != null && inSection(focusedPos)) {
    tr.setMeta(sectionFocusKey, { type: "show", position: to + focusedPos - section.pos });
  }
  if (inSection(selection.from)) {
    tr.setSelection(Selection.near(tr.doc.resolve(to + selection.from - section.pos)));
  }
  if (tr.selectionSet || tr.getMeta(sectionFocusKey)) editor.view.dispatch(tr);
}

export async function reorderSidebarSection(
  move: SectionReorder, active: { moduleId: string; editor: Editor; isReady: boolean } | null,
) {
  if (active?.moduleId !== move.moduleId || active.editor.isDestroyed) return;
  if (!active.isReady || !active.editor.isEditable) throw new Error("This note is read-only.");
  reorderOpen(active.editor, move);
  if (!await flushSaves()) throw new Error("The new order is waiting to save. Please retry saving before closing.");
}
