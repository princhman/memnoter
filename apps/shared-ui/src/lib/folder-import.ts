import type { JSONContent } from "@tiptap/core";
import { markdownToJSON } from "./markdown-paste.ts";

export type ImportEntry = { path: string; text?: string; bytes?: number[] };
export type ImportFolder = { name: string; entries: ImportEntry[] };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = (a: string, b: string) => natural.compare(a, b) || a.localeCompare(b);
const basename = (path: string) => path.split("/").pop()!;
const mimeTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const imageMime = (path: string) => mimeTypes[path.split(".").pop()!.toLowerCase()];
const heading = (title: string, level: number): JSONContent => ({ type: "heading", attrs: { level: Math.min(6, level) }, content: [{ type: "text", text: title }] });
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") { if (!parts.length) return ""; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Build everything before creating storage. Image ids are replaced on commit. */
export async function prepareFolderImport(folder: ImportFolder, progress: (message: string) => void = () => {}) {
  const entries = folder.entries.filter(e => !e.path.split("/").some(p => p.startsWith(".")));
  const notes = entries.filter(e => /\.md$/i.test(e.path)).sort((a, b) => compare(a.path, b.path));
  const images = entries.filter(e => imageMime(e.path));
  const skipped = entries.filter(e => !/\.md$/i.test(e.path) && !imageMime(e.path)).map(e => e.path).sort(compare);
  const unresolved: string[] = [];
  const usedImages = new Map<string, ImportEntry>();
  const order: string[] = [];
  const content: JSONContent[] = [];
  const hub = notes.find(e => e.path === `${folder.name}.md`);
  const resolve = (note: string, target: string) => {
    try { target = decodeURIComponent(target); } catch { /* keep literal name */ }
    const exact = normalize(target);
    const local = normalize(`${note.includes("/") ? note.slice(0, note.lastIndexOf("/") + 1) : ""}${target}`);
    return images.find(e => e.path === exact) ?? images.find(e => e.path === local) ?? images.filter(e => basename(e.path) === basename(target)).sort((a, b) => a.path.length - b.path.length || compare(a.path, b.path))[0];
  };
  async function addNote(entry: ImportEntry, level: number, isHub = false) {
    progress(`Reading note ${order.length + 1} of ${notes.length}: ${basename(entry.path)}`);
    order.push(entry.path);
    if (!isHub) content.push(heading(basename(entry.path).replace(/\.md$/i, ""), level));
    const source = (entry.text ?? "").replace(/^\uFEFF?[^\n:\r]+:[ \t]*\[\[([^\]\r\n]+)\]\][ \t]*\r?\n/, (line, target) => target === folder.name ? "" : line);
    const doc = markdownToJSON(source, (target, alt, width) => {
      const image = resolve(entry.path, target);
      if (!image) { unresolved.push(`${entry.path}: ${target}`); return undefined; }
      usedImages.set(image.path, image);
      return { type: "image", attrs: { fileId: image.path, imageId: crypto.randomUUID(), src: null, alt, width: width || null, masks: [] } };
    });
    const shift = (node: JSONContent) => {
      if (node.type === "heading") node.attrs = { ...node.attrs, level: Math.min(6, Number(node.attrs?.level ?? 1) + (isHub ? 0 : level)) };
      node.content?.forEach(shift);
    };
    shift(doc);
    content.push(...doc.content ?? []);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (hub) await addNote(hub, 0, true);
  async function walk(prefix: string, depth: number) {
    const children = notes.filter(e => e !== hub && e.path.startsWith(prefix));
    for (const note of children.filter(e => !e.path.slice(prefix.length).includes("/"))) await addNote(note, depth + 1);
    const folders = [...new Set(children.filter(e => e.path.slice(prefix.length).includes("/")).map(e => e.path.slice(prefix.length).split("/")[0]))].sort(compare);
    for (const name of folders) {
      content.push(heading(name.replace(/^\d+[\s._-]+/, ""), depth + 1));
      await walk(`${prefix}${name}/`, depth + 1);
    }
  }
  await walk("", 0);
  if (!notes.length) throw new Error("This folder contains no Markdown notes.");
  return { document: { type: "doc", content } as JSONContent, notes: order, images: [...usedImages.values()], skipped, unresolved };
}
