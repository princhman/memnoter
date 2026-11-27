import { useEffect } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { call, capabilities } from "./backend";
import { applySavedContent, type GetContentResponse } from "./content";
import { listDocuments } from "./documents";
import { isNoteFromNewerVersion } from "./editor-schema";
import { jsonToMarkdown, markdownLabel } from "./markdown-export";
import { queryClient } from "./query-client";
import type { Module } from "./types";

export type LocalBackupSettings = { folder: string | null; enabled: boolean };

export const localBackupSettings = queryOptions({
  queryKey: ["local-backup-settings"],
  queryFn: () => call<LocalBackupSettings>("local_backup_settings"),
  enabled: capabilities.localBackup,
});

export const localBackupError = queryOptions({
  queryKey: ["local-backup-error"],
  queryFn: (): string | null => null,
  initialData: null,
  enabled: false,
});

export function noteFilename(module: Module) {
  const title = [...module.name.normalize("NFC").toLowerCase().replace(/[\u0000-\u001f/\\:*?"<>|#[\]]/g, " ")
    .trim().replace(/^\.+/, "")].slice(0, 45).join("").trim();
  return `${title || "Untitled"} - ${module.id}.md`;
}

export function backupImageExtension(mime: string) {
  return /^image\/([a-z0-9]+)(?:\+xml)?$/.exec(mime)?.[1] ?? "bin";
}

export function backupPdfAppendix(pdfs: Awaited<ReturnType<typeof listDocuments>>, moduleId: string) {
  const links = pdfs.filter(pdf => pdf.moduleId === moduleId)
    .map(pdf => `- [${markdownLabel(pdf.name)}](attachments/${pdf.id}.pdf)`);
  return links.length ? ["## PDFs", ...links].join("\n") : "";
}

async function buildSnapshot(shouldContinue: () => boolean) {
  const modules = await call<Module[]>("modules");
  const pdfs = await listDocuments();
  const files = await call<Record<string, string>>("local_backup_image_types");

  const snapshot: Record<string,
    | { kind: "ready"; name: string; filename: string; markdown: string; attachments: Record<string, string> }
    | { kind: "skipped"; reason: string }> = {};

  for (const module of modules) {
    if (!shouldContinue()) return;
    const content = await call<GetContentResponse>("get_content", { moduleId: module.id });
    const doc = new Y.Doc();
    try {
      applySavedContent(doc, content);
      if (doc.store.pendingStructs || doc.store.pendingDs || isNoteFromNewerVersion(doc)) {
        throw new Error(`Cannot back up “${module.name}” until its content is supported and fully synced.`);
      }
      const attachments: Record<string, string> = {};
      function attachmentLink(id: string, extension: string) {
        const name = `${id}.${extension}`;
        attachments[name] = id;
        return `attachments/${name}`;
      }
      let missingImage = false;
      const markdown = jsonToMarkdown(yDocToProsemirrorJSON(doc, "default"), id => {
        const mime = Object.prototype.hasOwnProperty.call(files, id) ? files[id] : undefined;
        if (!mime) {
          missingImage = true;
          return "";
        }
        const extension = backupImageExtension(mime);
        return attachmentLink(id, extension);
      });
      if (missingImage) {
        snapshot[module.id] = { kind: "skipped", reason: `An image in “${module.name}” is unavailable.` };
        continue;
      }
      for (const pdf of pdfs) {
        if (pdf.moduleId === module.id) attachmentLink(pdf.id, "pdf");
      }
      snapshot[module.id] = {
        kind: "ready",
        name: module.name,
        filename: noteFilename(module),
        markdown: [markdown, backupPdfAppendix(pdfs, module.id)].filter(Boolean).join("\n\n") + "\n",
        attachments,
      };
    } finally {
      doc.destroy();
    }
  }
  return { modules: snapshot };
}

export function useLocalBackup() {
  const { data } = useQuery(localBackupSettings);
  const folder = data?.enabled ? data.folder : null;
  useEffect(() => {
    queryClient.setQueryData(localBackupError.queryKey, null);
    if (!folder) return;

    let active = true;
    let running = false;
    const backup = async () => {
      if (running) return;
      running = true;
      try {
        const snapshot = await buildSnapshot(() => active);
        if (!active || !snapshot) return;
        const warnings = await call<string[]>("write_local_backup", { folder, snapshot });
        for (const warning of warnings) console.warn(warning);
        if (active) queryClient.setQueryData(localBackupError.queryKey, warnings.join("\n") || null);
      } catch (error) {
        if (active) queryClient.setQueryData(localBackupError.queryKey,
          error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    };
    void backup();
    const timer = window.setInterval(() => void backup(), 10 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [folder]);
}
