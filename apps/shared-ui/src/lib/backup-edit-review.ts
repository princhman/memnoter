import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON, ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { call } from "./backend";
import { backupChangeTransaction, diffBackupNote, protectBackupHunks, type BackupHunk } from "./backup-edit-diff";
import { applySavedContent, type GetContentResponse } from "./content";
import { listDocuments } from "./documents";
import { isNoteFromNewerVersion, noteSchema } from "./editor-schema";
import { isSchemaReadOnly } from "./guarded-collaboration";
import { backupImageExtension, backupNoteRevision, backupPdfAppendix, backupSectionMarkdown, backupSections, noteFilename } from "./local-backup";
import { applyPendingSaves, saveQueue } from "./saves";
import type { Module } from "./types";
import { assertWritable } from "./write-lifecycle";

type EditedFile = {
  path: string;
  moduleId: string | null;
  noteName: string | null;
  markdown: string | null;
  hash: string;
  section?: number | null;
  headingId?: string | null;
  baselineHash?: string | null;
  noteRevisionHash?: string | null;
};

type SectionRef = { index: number; headingId: string | null };

type DiffInput = Pick<Parameters<typeof diffBackupNote>[0], "imagePath" | "pdfAppendix"> & { edited: string; section?: SectionRef & { original: string; baselineHash: string; revision: string; revisionHash: string } };

export type BackupReviewFile = { path: string; title: string; hash: string } & (
  | { kind: "read-only"; reason: string }
  | { kind: "note"; moduleId: string; hunks: BackupHunk[]; input: DiffInput }
);

function ownsNote(file: EditedFile, module: Module) {
  if (file.noteName !== null) return file.noteName === module.name;
  const filename = noteFilename(module).toLowerCase();
  const path = file.path.toLowerCase();
  return path === filename || path.startsWith(filename.slice(0, -3) + " - ");
}

function findSection(doc: ProseMirrorNode, { index, headingId }: SectionRef) {
  const sections = backupSections(doc.toJSON());
  if (index === 0) return sections[0];
  if (!headingId) return;
  const matches = sections.filter(section => section.headingId === headingId);
  if (matches.length === 1) return matches[0];
}

function reviewedHunks(doc: ProseMirrorNode, input: DiffInput) {
  if (!input.section) {
    return { offset: 0, hunks: protectBackupHunks(doc, diffBackupNote({ ...input, current: doc.toJSON() })) };
  }
  const section = findSection(doc, input.section);
  if (!section || backupSectionMarkdown(section.content, input.imagePath) !== input.section.original) {
    throw new Error("The note section changed. Check for edits again.");
  }
  const hunks = diffBackupNote({ ...input, current: { type: "doc", content: section.content } });
  const offset = section.offset;
  const protectedHunks = protectBackupHunks(doc, hunks.map(hunk => ({
    ...hunk, from: hunk.from + offset, to: hunk.to + offset,
  })));
  return { offset, hunks: protectedHunks.map(hunk => ({
    ...hunk, from: hunk.from - offset, to: hunk.to - offset,
  })) };
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
    const readOnly = (reason: string): BackupReviewFile => ({ kind: "read-only", path: file.path, hash: file.hash, title, reason });
    if (file.path.startsWith("attachments/")) return readOnly("Attachment edits can only be reset.");
    if (!module) return readOnly("The original note was deleted or could not be identified.");
    if (!ownsNote(file, module)) return readOnly("The original note was renamed.");
    if (file.path.includes("/") && file.section == null) return readOnly("PDF links are managed in Memnoter.");
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
      const prefix = file.section == null ? "" : "../";
      const input: DiffInput = {
        edited: file.markdown,
        imagePath: id => Object.prototype.hasOwnProperty.call(images, id) ? `${prefix}attachments/${id}.${backupImageExtension(images[id])}` : "",
        pdfAppendix: file.section == null ? backupPdfAppendix(pdfs, module.id) : "",
      };
      if (file.section != null) {
        const revision = backupNoteRevision(yDoc);
        if (!revision || !file.noteRevisionHash ||
          await call<string>("local_backup_markdown_hash", { markdown: revision }) !== file.noteRevisionHash) {
          return readOnly("The note no longer matches its backup snapshot. The edit is still in the backup file.");
        }
        const ref = { index: file.section, headingId: file.headingId ?? null };
        const section = findSection(doc, ref);
        if (!section) return readOnly("The original heading could not be identified. The edit is still in the backup file.");
        const original = backupSectionMarkdown(section.content, input.imagePath);
        if (!file.baselineHash ||
          (original !== file.markdown && await call<string>("local_backup_markdown_hash", { markdown: original }) !== file.baselineHash)) {
          return readOnly("This section has changed in Memnoter since it was backed up.");
        }
        input.section = { ...ref, original, baselineHash: file.baselineHash, revision, revisionHash: file.noteRevisionHash };
      }
      const { hunks } = reviewedHunks(doc, input);
      return { kind: "note", path: file.path, title, moduleId: module.id, hash: file.hash, hunks, input };
    } catch (error) {
      return readOnly(error instanceof Error ? error.message : "This note could not be loaded.");
    } finally {
      yDoc.destroy();
    }
  }));
}

type NoteFile = Extract<BackupReviewFile, { kind: "note" }>;

export async function recheckBackupFiles(folder: string, notes: readonly NoteFile[]) {
  const [files, modules, pdfs] = await Promise.all([
    readBackupEdits(folder), call<Module[]>("modules"), listDocuments(),
  ]);
  for (const note of notes) {
    const file = files.find(file => file.path === note.path && file.hash === note.hash && file.moduleId === note.moduleId);
    const module = modules.find(module => module.id === note.moduleId);
    if (!file || !module || !ownsNote(file, module) ||
      (note.input.section
        ? file.section !== note.input.section.index || (file.headingId ?? null) !== note.input.section.headingId ||
          file.baselineHash !== note.input.section.baselineHash || file.noteRevisionHash !== note.input.section.revisionHash
        : file.section != null || backupPdfAppendix(pdfs, note.moduleId) !== note.input.pdfAppendix)) {
      throw new Error("The backup file or note changed. Check for edits again.");
    }
  }
}

export function applyBackupHunks(editor: Editor, notes: readonly NoteFile[]) {
  assertWritable();
  if (editor.isDestroyed || !editor.isEditable || isSchemaReadOnly(editor)) {
    throw new Error("This note is currently read-only.");
  }
  const first = notes[0];
  if (!first) return;
  const section = first.input.section;
  if (section) {
    const yDoc: unknown = ySyncPluginKey.getState(editor.state)?.doc;
    if (!(yDoc instanceof Y.Doc) || backupNoteRevision(yDoc) !== section.revision ||
      notes.some(note => note.moduleId !== first.moduleId || note.input.section?.revision !== section.revision) ||
      new Set(notes.map(note => note.input.section?.index)).size !== notes.length) {
      throw new Error("The note changed after you checked the backup. Check for edits again.");
    }
  } else if (notes.length !== 1) {
    throw new Error("Only heading files from the same backup can be applied together.");
  }
  const current = editor.state.doc;
  const hunks = [...notes]
    .sort((a, b) => (a.input.section?.index ?? 0) - (b.input.section?.index ?? 0))
    .flatMap(note => {
      const { offset, hunks: latest } = reviewedHunks(current, note.input);
      if (JSON.stringify(latest) !== JSON.stringify(note.hunks)) {
        throw new Error("The note changed after you checked the backup. Check for edits again.");
      }
      return latest.filter(hunk => !hunk.reason).map(hunk => ({
        ...hunk, from: hunk.from + offset, to: hunk.to + offset,
      }));
    });
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
