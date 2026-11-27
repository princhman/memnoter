import { yDocToProsemirrorJSON, yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { call } from "./backend";
import { backupChangeTransaction, diffBackupNote, protectBackupHunks, type BackupHunk } from "./backup-edit-diff";
import { applySavedContent, type GetContentResponse } from "./content";
import { listDocuments } from "./documents";
import { isNoteFromNewerVersion, noteSchema } from "./editor-schema";
import { isSchemaReadOnly } from "./guarded-collaboration";
import { backupImageExtension, backupPdfAppendix, noteFilename } from "./local-backup";
import { applyPendingSaves, saveQueue } from "./saves";
import type { Module } from "./types";
import { assertWritable } from "./write-lifecycle";

type EditedFile = {
  path: string;
  moduleId: string | null;
  noteName: string | null;
  markdown: string | null;
  hash: string;
};

type DiffInput = Pick<Parameters<typeof diffBackupNote>[0], "imagePath" | "pdfAppendix"> & { edited: string };

export type BackupReviewFile = { path: string; title: string } & (
  | { kind: "read-only"; reason: string }
  | { kind: "note"; moduleId: string; hash: string; hunks: BackupHunk[]; input: DiffInput }
);

function ownsNote(file: EditedFile, module: Module) {
  if (file.noteName !== null) return file.noteName === module.name;
  const filename = noteFilename(module).toLowerCase();
  const path = file.path.toLowerCase();
  return path === filename || path.startsWith(filename.slice(0, -3) + " - ");
}

export function readBackupEdits(folder: string) {
  return call<EditedFile[]>("read_local_backup_edits", { folder });
}

export async function buildBackupReview(edited: EditedFile[]): Promise<BackupReviewFile[]> {
  if (!edited.length) return [];

  const [modules, pdfs, images] = await Promise.all([
    call<Module[]>("modules"), listDocuments(), call<Record<string, string>>("local_backup_image_types"),
  ]);
  return Promise.all(edited.map(async (file): Promise<BackupReviewFile> => {
    const module = modules.find(module => module.id === file.moduleId);
    const title = file.noteName ?? module?.name ?? file.path;
    const readOnly = (reason: string): BackupReviewFile => ({ kind: "read-only", path: file.path, title, reason });
    if (file.path.startsWith("attachments/")) return readOnly("Attachment edits must be handled separately.");
    if (!module) return readOnly("The original note was deleted or could not be identified.");
    if (!ownsNote(file, module)) return readOnly("The original note was renamed.");
    if (file.markdown === null) return readOnly("This file is unreadable as UTF-8 Markdown.");

    const pending = saveQueue.pending(module.id);
    const yDoc = new Y.Doc();
    try {
      const content = await call<GetContentResponse>("get_content", { moduleId: module.id });
      applySavedContent(yDoc, content);
      applyPendingSaves(yDoc, pending);
      if (yDoc.store.pendingStructs || yDoc.store.pendingDs || isNoteFromNewerVersion(yDoc)) {
        return readOnly("This note is still syncing or requires a newer version of Memnoter.");
      }
      const doc = noteSchema().nodeFromJSON(yDocToProsemirrorJSON(yDoc, "default"));
      const input: DiffInput = {
        edited: file.markdown,
        imagePath: id => Object.prototype.hasOwnProperty.call(images, id) ? `attachments/${id}.${backupImageExtension(images[id])}` : "",
        pdfAppendix: backupPdfAppendix(pdfs, module.id),
      };
      const hunks = protectBackupHunks(doc, diffBackupNote({ ...input, current: doc.toJSON() }));
      return { kind: "note", path: file.path, title, moduleId: module.id, hash: file.hash, hunks, input };
    } catch (error) {
      return readOnly(error instanceof Error ? error.message : "This note could not be loaded.");
    } finally {
      yDoc.destroy();
    }
  }));
}

export async function recheckBackupFile(folder: string, note: Extract<BackupReviewFile, { kind: "note" }>) {
  const [files, modules, pdfs] = await Promise.all([
    readBackupEdits(folder), call<Module[]>("modules"), listDocuments(),
  ]);
  const file = files.find(file => file.path === note.path && file.hash === note.hash && file.moduleId === note.moduleId);
  const module = modules.find(module => module.id === note.moduleId);
  if (!file || !module || !ownsNote(file, module) || backupPdfAppendix(pdfs, note.moduleId) !== note.input.pdfAppendix) {
    throw new Error("The backup file or note changed. Check for edits again.");
  }
}

export function applyBackupHunks(editor: Editor, note: Extract<BackupReviewFile, { kind: "note" }>, selected: readonly number[]) {
  assertWritable();
  if (editor.isDestroyed || !editor.isEditable || isSchemaReadOnly(editor)) {
    throw new Error("This note is currently read-only.");
  }
  const current = editor.state.doc;
  const latest = protectBackupHunks(current, diffBackupNote({ ...note.input, current: current.toJSON() }));
  if (JSON.stringify(latest) !== JSON.stringify(note.hunks)) {
    throw new Error("The note changed after you checked the backup. Check for edits again.");
  }
  const hunks = selected.map(index => latest[index]);
  const tr = backupChangeTransaction(editor.state, hunks);
  if (!tr.docChanged) return;
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  editor.view.dispatch(tr);
  undo?.stopCapturing();
  if (editor.state.doc.eq(current)) {
    throw new Error("The editor could not apply the selected changes.");
  }
}
