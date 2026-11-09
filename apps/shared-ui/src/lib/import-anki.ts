import { Editor, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { call } from "./backend.ts";
import { noteExtensions } from "./editor-schema";
import { imageMime } from "./folder-import.ts";
import { writeOperation } from "./write-lifecycle";
import { refreshDerived } from "./note-index";
import type { AnkiImportPlan, AnkiPackage } from "./anki-import.ts";
import { ankiHistory } from "./anki-schedule.ts";
import { bakeAnkiLabels } from "./anki-labels.ts";
import type { SidebarItem } from "./sidebar-layout.ts";

export type AnkiSession = { sourceId: string; fileName: string; package: AnkiPackage };
let importing = false;
export async function importAnki(session: AnkiSession, plan: AnkiImportPlan, progress: (message: string) => void) {
  if (importing) throw new Error("An Anki import is already in progress.");
  importing = true;
  const saved: { id: string; name: string }[] = [];
  const warnings = [...plan.warnings];
  try {
    return await writeOperation(async permit => {
      const existing = await call<{ name: string }[]>("modules");
      const names = new Set(existing.map(m => m.name));
      for (const module of plan.modules) {
        let name = module.name;
        for (let suffix = 2; names.has(name); suffix++) name = `${module.name} ${suffix}`;
        names.add(name);
        progress(`Preparing ${name}…`);
        const doc = new Y.Doc();
        const editor = new Editor({ element: document.createElement("div"), extensions: noteExtensions({ document: doc }) });
        try {
          editor.commands.setContent(module.document);
          editor.state.doc.check();
          const normalized = editor.getJSON();
          const refs = new Set<string>();
          function visit(node: JSONContent, fn: (node: JSONContent) => void) { fn(node); node.content?.forEach(n => visit(n, fn)); }
          visit(normalized, node => { if (node.type === "image" && typeof node.attrs?.fileId === "string") refs.add(node.attrs.fileId); });
          const images: { id: string; bytes: number[]; mimeType: string | undefined }[] = [];
          const ids = new Map<string, string>();
          for (const ref of refs) {
            const source = plan.labels[ref] ? ref.slice(0, ref.lastIndexOf("#")) : ref;
            const [bytes] = await call<number[][]>("read_anki_media", { sourceId: session.sourceId, names: [source] });
            if (!bytes) throw new Error(`Image could not be read: ${source}`);
            const baked = await bakeAnkiLabels(bytes, imageMime(source) ?? "image/png", plan.labels[ref] ?? [], warning => warnings.push(warning));
            const id = crypto.randomUUID();
            images.push({ id, ...baked });
            ids.set(ref, id);
          }
          visit(normalized, node => { if (node.attrs?.fileId && ids.has(node.attrs.fileId)) node.attrs.fileId = ids.get(node.attrs.fileId); });
          const persisted = prosemirrorJSONToYDoc(editor.schema, normalized, "default");
          let bytes: number[];
          try { bytes = Array.from(Y.encodeStateAsUpdate(persisted)); } finally { persisted.destroy(); }
          progress(`Saving ${name}…`);
          const id = await call<string>("import_module", { name, bytes, images });
          saved.push({ id, name });
          await refreshDerived(id, permit);
          const histories = (await Promise.all(module.histories.map(ankiHistory))).filter(h => h !== null);
          if (histories.length) {
            const skipped = await call<string[]>("import_card_history", { histories });
            if (skipped.length) warnings.push(`${skipped.length} card schedules could not be imported in ${name}.`);
          }
          if (module.folder) {
            const sidebar = await call<SidebarItem[]>("sidebar_items");
            let folder = sidebar.find(item => !item.deleted && item.name === module.folder);
            if (!folder) {
              folder = { id: crypto.randomUUID(), name: module.folder, folder_id: null, sort_order: Math.max(-1, ...sidebar.map(i => i.sort_order)) + 1, collapsed: false, deleted: false };
            }
            await call("save_sidebar_items", { items: [folder, { id, name: null, folder_id: folder.id, sort_order: Math.max(-1, ...sidebar.map(i => i.sort_order)) + 1, collapsed: false, deleted: false }] });
          }
        } finally { editor.destroy(); doc.destroy(); }
      }
      return { modules: saved, cards: plan.cards, warnings };
    });
  } catch (error) {
    throw new Error(`${String(error)} Saved modules: ${saved.map(m => m.name).join(", ") || "none"}. Close this dialog before importing again to avoid duplicates.`);
  } finally { importing = false; }
}
