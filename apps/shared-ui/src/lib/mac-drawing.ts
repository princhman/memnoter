import type { Editor } from "@tiptap/core";
import { call } from "./backend";
import { patchContent, type FileType } from "./content";
import { flushSaves } from "./saves";
import { assertWritable, writeOperation } from "./write-lifecycle";
import { drawingReference } from "./drawing";
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
    // AppKit transfers first responder to the canvas and restores it on close.
    // Keep the DOM caret: Tiptap blur also clears the browser selection on a
    // later animation frame, and restoring NSWindow focus cannot undo that.
    const result = await call<Result>("edit_drawing", { moduleId, imageId, sourceId: target?.sourceId ?? null });
    assertWritable(permit);
    if (editor.isDestroyed) throw new Error("The note was closed. Your drawing is saved as a local draft; reopen its drawing to continue.");
    if (result.status === "save") {
      if (!result.source || !result.preview) throw new Error("The drawing save was incomplete. Your local draft is retained.");
      let targetExists = false;
      editor.state.doc.descendants(node => {
        if (node.attrs.imageId === imageId && drawingReference(node.attrs.drawing)) targetExists = true;
      });
      // Done must preserve the ink if a peer removed its original embed.
      const makingCopy = result.asCopy || !targetExists;
      const copyId = makingCopy ? crypto.randomUUID() : imageId;
      if (makingCopy) execEditor(editor, "beginDrawing", { imageId: copyId });
      patchContent(moduleId, old => ({ ...old, files: [...old.files, result.source!, result.preview!] }));
      execEditor(editor, "commitDrawing", { imageId: copyId, sourceId: result.source.id, previewId: result.preview.id,
        expectedSourceId: makingCopy ? null : result.expectedSourceId ?? null });
      await flushSaves();
      await call("drawing_committed", { moduleId, imageId });
    } else if (!target && (result.status === "empty" || result.status === "discarded" || result.status === "active" || (result.status === "cancel" && !result.hasChanges))) {
      execEditor(editor, "discardEmptyDrawing", { imageId });
      await flushSaves();
    }
    execEditor(editor, "clearImageSelection");
  });
}
