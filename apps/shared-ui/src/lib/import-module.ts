import { Editor, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { call } from "./backend.ts";
import { noteExtensions } from "./note-extensions";
import { imageMime, prepareFolderImport, type ImportOptions, type ImportFolder } from "./folder-import.ts";
import { writeOperation, type WritePermit } from "./write-lifecycle";
import { refreshDerived } from "./note-index";

let importing = false;
export async function importFolder(folder: ImportFolder, progress: (message: string) => void, options: Partial<ImportOptions> = {}) {
  if (importing) throw new Error("A folder import is already in progress.");
  importing = true;
  try { return await writeOperation(permit => runImport(folder, progress, options, permit)); }
  finally { importing = false; }
}

async function runImport(folder: ImportFolder, progress: (message: string) => void, options: Partial<ImportOptions>, permit: WritePermit) {
  progress("Scan: checking selected files…");
  const plan = await prepareFolderImport(folder, progress, options);
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
    progress("Save: reading referenced images…");
    const lazy = plan.images.filter(image => !image.bytes && image.sourceId);
    if (lazy.length) {
      const loaded = await call<number[][]>("read_import_images", { images: lazy.map(image => ({ sourceId: image.sourceId, path: image.path.slice(image.sourceId!.length + 1) })) });
      lazy.forEach((image, index) => { image.bytes = loaded[index]; });
    }
    const ids = new Map<string, string>();
    const images = [];
    for (const [index, image] of plan.images.entries()) {
      progress(`Save: image ${index + 1} of ${plan.images.length}`);
      if (!image.bytes) throw new Error(`Image could not be read: ${image.path}`);
      const id = crypto.randomUUID();
      images.push({ id, bytes: image.bytes, mimeType: imageMime(image.path) });
      ids.set(image.path, id);
    }
    function replaceAssets(node: JSONContent) {
      if (node.attrs?.fileId && ids.has(node.attrs.fileId)) node.attrs.fileId = ids.get(node.attrs.fileId);
      node.content?.forEach(replaceAssets);
    }
    replaceAssets(normalized);
    const persisted = prosemirrorJSONToYDoc(editor.schema, normalized, "default");
    const bytes = Array.from(Y.encodeStateAsUpdate(persisted));
    persisted.destroy();
    progress("Save: committing module…");
    moduleId = await call<string>("import_module", { name, bytes, images });
    let indexingWarning: string | undefined;
    try {
      progress("Indexing notes and cards…");
      await refreshDerived(moduleId, permit);
    } catch (error) {
      console.error("Imported note could not be indexed after retries:", error);
      indexingWarning = "Imported; search and card indexing failed. Reopen the note to retry.";
    }
    return { moduleId, name, ...plan, indexingWarning };
  } finally { editor.destroy(); doc.destroy(); }
}
