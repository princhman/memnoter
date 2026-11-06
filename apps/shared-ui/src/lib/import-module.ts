import { Editor, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { call } from "./backend.ts";
import { noteExtensions } from "./note-extensions";
import { imageMime, prepareFolderImport, type ImportFolder } from "./folder-import.ts";
import type { FileType, ContentUpdate } from "./content.ts";
import { reindexStoredCards } from "./card-backfill";
import { indexStoredNote } from "./search-index";

let importing = false;
export async function importFolder(folder: ImportFolder, progress: (message: string) => void) {
  if (importing) throw new Error("A folder import is already in progress.");
  importing = true;
  try { return await runImport(folder, progress); }
  finally { importing = false; }
}

async function runImport(folder: ImportFolder, progress: (message: string) => void) {
  const plan = await prepareFolderImport(folder, progress);
  const doc = new Y.Doc();
  const editor = new Editor({ element: document.createElement("div"), extensions: noteExtensions({ document: doc }) });
  let moduleId: string | undefined;
  try {
    // The real editor assigns card identities and normalizes headings before
    // storage exists. Opening the imported document uses precisely this schema.
    editor.commands.setContent(plan.document);
    await new Promise(resolve => setTimeout(resolve, 0));
    editor.state.doc.check();
    // Export the normalized tree into a fresh history. A first persisted update
    // must contain insertions only: the image lease validator rejects deletions
    // referring to a revision that was never stored.
    const normalized = editor.getJSON();
    const modules = await call<{ name: string }[]>("modules");
    let name = folder.name;
    for (let suffix = 2; modules.some(m => m.name === name); suffix++) name = `${folder.name} ${suffix}`;
    moduleId = await call<string>("create_module", { name });
    const ids = new Map<string, string>();
    for (const [index, image] of plan.images.entries()) {
      progress(`Saving image ${index + 1} of ${plan.images.length}`);
      if (!image.bytes) throw new Error(`Image could not be read: ${image.path}`);
      const saved = await call<FileType>("save_file", { moduleId, bytes: image.bytes, mimeType: imageMime(image.path) });
      ids.set(image.path, saved.id);
    }
    function replaceAssets(node: JSONContent) {
      if (node.attrs?.fileId && ids.has(node.attrs.fileId)) node.attrs.fileId = ids.get(node.attrs.fileId);
      node.content?.forEach(replaceAssets);
    }
    replaceAssets(normalized);
    const persisted = prosemirrorJSONToYDoc(editor.schema, normalized, "default");
    const bytes = Array.from(Y.encodeStateAsUpdate(persisted));
    persisted.destroy();
    const update = await call<ContentUpdate>("add_update", { moduleId, bytes });
    await call("save_compaction", { moduleId, newState: bytes, updateId: update.id });
    progress("Indexing notes and cards…");
    await indexStoredNote(moduleId);
    await reindexStoredCards(moduleId);
    return { moduleId, name, ...plan };
  } catch (error) {
    if (moduleId) {
      try { await call("delete_module", { moduleId }); }
      catch (cleanup) { throw new Error(`Import failed: ${String(error)}. Could not remove partial module ${moduleId}: ${String(cleanup)}`); }
    }
    throw error;
  } finally { editor.destroy(); doc.destroy(); }
}
