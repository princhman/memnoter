import type { JSONContent } from "@tiptap/core";
import { useEffect } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { call, capabilities } from "./backend";
import { applySavedContent, type GetContentResponse } from "./content";
import { listDocuments } from "./documents";
import { isNoteFromNewerVersion } from "./editor-schema";
import { jsonToMarkdown, markdownLabel } from "./markdown-export";
import { TOC_ID_ATTRIBUTE } from "./outline";
import { queryClient } from "./query-client";
import type { Module } from "./types";

export type LocalBackupSettings = { folder: string | null; enabled: boolean; splitByHeading?: boolean };

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

export function backupPdfAppendix(pdfs: Awaited<ReturnType<typeof listDocuments>>, moduleId: string, prefix = "") {
  const links = pdfs.filter(pdf => pdf.moduleId === moduleId)
    .map(pdf => `- [${markdownLabel(pdf.name)}](${prefix}attachments/${pdf.id}.pdf)`);
  return links.length ? ["## PDFs", ...links].join("\n") : "";
}

export function backupSections(doc: JSONContent) {
  const sections: { offset: number; content: JSONContent[]; headingId: string | null }[] = [
    { offset: 0, content: [], headingId: null },
  ];
  for (const [offset, block] of (doc.content ?? []).entries()) {
    if (block.type === "heading") {
      const id = block.attrs?.[TOC_ID_ATTRIBUTE];
      sections.push({ offset, content: [], headingId: typeof id === "string" && id ? id : null });
    }
    sections[sections.length - 1].content.push(block);
  }
  return sections;
}

export function backupSectionMarkdown(content: JSONContent[], imagePath: (id: string) => string) {
  return jsonToMarkdown({ type: "doc", content }, imagePath) + "\n";
}

function headingFilename(heading: JSONContent) {
  const title = heading.content?.map(node => node.text ?? "").join("") ?? "";
  return [...title.normalize("NFC").replace(/[^\p{L}\p{N} -]/gu, " ").replace(/ +/g, " ").trim()]
    .slice(0, 45).join("").trimEnd() || "Heading";
}

async function buildSnapshot(splitByHeading: boolean, shouldContinue: () => boolean) {
  const modules = await call<Module[]>("modules");
  const pdfs = await listDocuments();
  const files = await call<Record<string, string>>("local_backup_image_types");

  const snapshot: Record<string,
    | { kind: "ready"; name: string; filename: string; markdown: string; sections?: { filename: string; markdown: string; section?: number; heading_id?: string }[]; attachments: Record<string, string> }
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
        return `${splitByHeading ? "../" : ""}attachments/${name}`;
      }
      let missingImage = false;
      const contentJson = yDocToProsemirrorJSON(doc, "default");
      const imagePath = (id: string) => {
        const mime = Object.prototype.hasOwnProperty.call(files, id) ? files[id] : undefined;
        if (!mime) {
          missingImage = true;
          return "";
        }
        const extension = backupImageExtension(mime);
        return attachmentLink(id, extension);
      };
      const noteSections = splitByHeading ? backupSections(contentJson) : undefined;
      const headingCounts = new Map<string, number>();
      for (const { headingId } of noteSections ?? []) {
        if (headingId) headingCounts.set(headingId, (headingCounts.get(headingId) ?? 0) + 1);
      }
      const sections = noteSections?.flatMap(({ content, headingId }, section, all) => {
        const markdown = backupSectionMarkdown(content, imagePath);
        if (section === 0 && markdown === "\n" && all.length > 1) return [];
        const title = section === 0 ? "Preamble" : headingFilename(content[0]);
        const number = String(section).padStart(Math.max(4, String(all.length).length), "0");
        return [{
          filename: `${number} - ${title}.md`, markdown, section,
          heading_id: headingId && headingCounts.get(headingId) === 1 ? headingId : undefined,
        }];
      });
      const markdown = sections ? "" : jsonToMarkdown(contentJson, imagePath);
      if (missingImage) {
        snapshot[module.id] = { kind: "skipped", reason: `An image in “${module.name}” is unavailable.` };
        continue;
      }
      for (const pdf of pdfs) {
        if (pdf.moduleId === module.id) attachmentLink(pdf.id, "pdf");
      }
      const pdfAppendix = backupPdfAppendix(pdfs, module.id, sections ? "../" : "");
      snapshot[module.id] = {
        kind: "ready",
        name: module.name,
        filename: noteFilename(module),
        markdown: [markdown, pdfAppendix].filter(Boolean).join("\n\n") + "\n",
        sections: sections && [
          ...sections,
          ...(pdfAppendix ? [{ filename: "PDFs.md", markdown: pdfAppendix + "\n" }] : []),
        ],
        attachments,
      };
    } finally {
      doc.destroy();
    }
  }
  return { modules: snapshot };
}

export function useLocalBackup(checkForEdits: (folder: string, isActive: () => boolean) => Promise<void>) {
  const { data } = useQuery(localBackupSettings);
  const folder = data?.enabled ? data.folder : null;
  const splitByHeading = data?.splitByHeading ?? false;
  useEffect(() => {
    queryClient.setQueryData(localBackupError.queryKey, null);
    if (!folder) return;

    let active = true;
    let running = false;
    const backup = async () => {
      if (running) return;
      running = true;
      try {
        const snapshot = await buildSnapshot(splitByHeading, () => active);
        if (active && snapshot) {
          const warnings = await call<string[]>("write_local_backup", { folder, snapshot, splitByHeading });
          for (const warning of warnings) console.warn(warning);
          if (active) queryClient.setQueryData(localBackupError.queryKey, warnings.join("\n") || null);
        }
      } catch (error) {
        if (active) queryClient.setQueryData(localBackupError.queryKey,
          error instanceof Error ? error.message : String(error));
      }
      try {
        if (active) await checkForEdits(folder, () => active);
      } catch (error) {
        if (active) console.warn("Could not check the local backup for edits.", error);
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
  }, [folder, splitByHeading, checkForEdits]);
}
