import type { Editor } from "@tiptap/core";
import { call } from "./backend";
import { patchContent, type FileType } from "./content";
import { flushSaves } from "./saves";
import { assertWritable, writeOperation } from "./write-lifecycle";
import { execEditor } from "../editor-host/commands";

type Result = {
  status: "save" | "cancel" | "empty" | "unchanged" | "active" | "discarded";
  source?: FileType;
  preview?: FileType;
  expectedSourceId?: string | null;
  asCopy: boolean;
  hasChanges: boolean;
};

export async function openMacDrawing(editor: Editor, moduleId: string, target?: { imageId: string; sourceId: string | null }) {
  if (editor.isDestroyed || !editor.isEditable) return;
  const imageId = target?.imageId ?? crypto.randomUUID();
  await writeOperation(async permit => {
    assertWritable(permit);
    if (!target) execEditor(editor, "beginDrawing", { imageId });
    await flushSaves();
    execEditor(editor, "clearImageSelection");
    editor.commands.blur();
    const result = await call<Result>("edit_drawing", { moduleId, imageId, sourceId: target?.sourceId ?? null });
    assertWritable(permit);
    if (editor.isDestroyed) throw new Error("The note was closed. Your drawing is saved as a local draft; reopen its drawing to continue.");
    if (result.status === "save") {
      if (!result.source || !result.preview) throw new Error("The drawing save was incomplete. Your local draft is retained.");
      const copyId = result.asCopy ? crypto.randomUUID() : imageId;
      if (result.asCopy) execEditor(editor, "beginDrawing", { imageId: copyId });
      patchContent(moduleId, old => ({ ...old, files: [...old.files, result.source!, result.preview!] }));
      execEditor(editor, "commitDrawing", { imageId: copyId, sourceId: result.source.id, previewId: result.preview.id,
        expectedSourceId: result.asCopy ? null : result.expectedSourceId ?? null });
      await flushSaves();
      await call("drawing_committed", { moduleId, imageId });
    } else if (result.status === "empty" || (result.status === "discarded" && !target?.sourceId) || (!target && (result.status === "active" || (result.status === "cancel" && !result.hasChanges)))) {
      execEditor(editor, "discardEmptyDrawing", { imageId });
      await flushSaves();
    }
    execEditor(editor, "clearImageSelection");
  });
}
