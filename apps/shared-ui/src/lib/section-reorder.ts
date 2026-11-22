import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { TextSelection } from "@tiptap/pm/state";
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
  const length = section.end - section.pos;
  const to = at > section.end ? at - length : at;
  const slice = editor.state.doc.slice(section.pos, section.end).content;
  const focusedPos = sectionFocusKey.getState(editor.state);
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  manager?.stopCapturing();
  const tr = editor.state.tr.delete(section.pos, section.end).insert(to, slice);
  tr.setMeta("heading-outline-adjustment", true);
  if (focusedPos != null) {
    const position = focusedPos >= section.pos && focusedPos < section.end
      ? to + focusedPos - section.pos
      : tr.mapping.map(focusedPos);
    tr.setMeta(sectionFocusKey, { type: "show", position });
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
  if (active?.moduleId !== move.moduleId || active.editor.isDestroyed) return;
  if (!active.isReady || !active.editor.isEditable) throw new Error("This note is read-only.");
  reorderOpen(active.editor, move);
  if (!await flushSaves()) throw new Error("The new order is waiting to save. Please retry saving before closing.");
}
