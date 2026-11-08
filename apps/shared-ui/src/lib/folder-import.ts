import type { JSONContent } from "@tiptap/core";
import { markdownToJSON } from "./markdown-paste.ts";

export type ImportEntry = { path: string; text?: string; bytes?: number[]; sourceId?: string };
export type ImportFolder = { name: string; entries: ImportEntry[]; originalName?: string };
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

export type ImportOptions = {
  order?: string[]; excluded?: string[]; extraImages?: ImportEntry[]; extraImageFolder?: string;
  removeNoteLinks: boolean; removeUnsupportedEmbeds: boolean;
  keepFrontMatter: boolean;
};
export const defaultImportOptions: ImportOptions = { removeNoteLinks: true, removeUnsupportedEmbeds: true, keepFrontMatter: false };
export function importNoteOrder(folder: ImportFolder): string[] {
  const notes = folder.entries.filter(e => /\.md$/i.test(e.path) && !e.path.split("/").some(p => p.startsWith("."))).map(e => e.path);
  const hub = `${folder.name}.md`;
  function walk(prefix: string): string[] {
    const children = notes.filter(p => p !== hub && p.startsWith(prefix));
    return [...children.filter(p => !p.slice(prefix.length).includes("/")).sort(compare), ...[...new Set(children.filter(p => p.slice(prefix.length).includes("/")).map(p => p.slice(prefix.length).split("/")[0]))].sort(compare).flatMap(p => walk(`${prefix}${p}/`))];
  }
  return [...(notes.includes(hub) ? [hub] : []), ...walk("")];
}

/** A preview and conversion use the same plan; neither writes storage. */
export async function prepareFolderImport(folder: ImportFolder, progress: (message: string) => void = () => {}, settings: Partial<ImportOptions> = {}) {
  const options = { ...defaultImportOptions, ...settings };
  const entries = folder.entries.filter(e => !e.path.split("/").some(p => p.startsWith(".")));
  const byPath = new Map(entries.map(e => [e.path, e]));
  const notes = [...new Set(options.order ?? importNoteOrder(folder))].filter(p => /\.md$/i.test(p) && byPath.has(p) && !options.excluded?.includes(p)).map(p => byPath.get(p)!);
  const images = [...entries.filter(e => imageMime(e.path)), ...(options.extraImages ?? []).filter(e => imageMime(e.path))];
  const skipped = entries.filter(e => !/\.md$/i.test(e.path) && !imageMime(e.path)).map(e => e.path).sort(compare);
  const unresolved: string[] = [];
  const imageIssues: { note: string; target: string; ambiguous: boolean }[] = [];
  let resolvedReferences = 0;
  const usedImages = new Map<string, ImportEntry>();
  const order: string[] = [];
  const content: JSONContent[] = [];
  let previousFolders: string[] = [];
  const resolve = (note: string, target: string, syntax?: "markdown" | "wiki") => {
    try { target = decodeURIComponent(target); } catch { /* keep literal */ }
    const exact = normalize(target);
    const local = normalize(`${note.includes("/") ? note.slice(0, note.lastIndexOf("/") + 1) : ""}${target}`);
    const paths = syntax === "markdown" ? [local, exact] : [exact, local];
    for (const path of paths) {
      const matches = images.filter(e => e.path === path);
      if (matches.length === 1) return { image: matches[0], ambiguous: false };
      if (matches.length > 1) return { ambiguous: true };
    }
    // References may name the picked image folder, e.g. `attachments/pic.png`
    // after picking `attachments`.
    const folderName = options.extraImageFolder;
    const picked = folderName ? (options.extraImages ?? []).filter(e => imageMime(e.path) && paths.some(path => path === `${folderName}/${e.path}` || path.endsWith(`/${folderName}/${e.path}`))) : [];
    if (picked.length) return { image: picked.length === 1 ? picked[0] : undefined, ambiguous: picked.length > 1 };
    // A path-qualified reference must never silently select an unrelated namesake.
    const matches = target.replace(/^\.\//, "").includes("/") ? [] : images.filter(e => basename(e.path) === basename(target));
    return { image: matches.length === 1 ? matches[0] : undefined, ambiguous: matches.length > 1 };
  };
  for (const entry of notes) {
    progress(`Convert: note ${order.length + 1} of ${notes.length}: ${basename(entry.path)}`);
    order.push(entry.path);
    const folders = entry.path.split("/").slice(0, -1);
    folders.forEach((name, i) => {
      if (previousFolders.slice(0, i + 1).join("/") !== folders.slice(0, i + 1).join("/")) content.push(heading(name.replace(/^\d+[\s._-]+/, ""), i + 1));
    });
    previousFolders = folders;
    const level = folders.length + 1;
    const isHub = entry.path === `${folder.originalName ?? folder.name}.md`;
    if (!isHub) content.push(heading(basename(entry.path).replace(/\.md$/i, ""), level));
    const source = (entry.text ?? "").replace(/^((?:\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*\r?\n)?)(?:up|parent):[ \t]*\[\[[^\]\r\n]+\]\][ \t]*\r?\n/i, "$1");
    const doc = markdownToJSON(source, (target, alt, width, syntax) => {
      const { image, ambiguous } = resolve(entry.path, target, syntax);
      if (!image) { unresolved.push(`${entry.path}: ${target}${ambiguous ? " (ambiguous)" : ""}`); imageIssues.push({ note: entry.path, target, ambiguous }); return undefined; }
      resolvedReferences++;
      const key = image.sourceId ? `${image.sourceId}/${image.path}` : image.path;
      usedImages.set(key, { ...image, path: key });
      return { type: "image", attrs: { fileId: key, imageId: crypto.randomUUID(), src: null, alt, width: width || null, masks: [] } };
    }, options);
    // The editor keeps headings in a strict hierarchy anyway, so always nest each
    // note's headings under its title; peer headings stay peers even when levels skip.
    const levels = [...new Set((doc.content ?? []).filter(n => n.type === "heading").map(n => Number(n.attrs?.level ?? 1)))].sort((a,b) => a-b);
    for (const node of doc.content ?? []) if (node.type === "heading") node.attrs = { ...node.attrs, level: Math.min(6, (isHub ? 0 : level) + 1 + levels.indexOf(Number(node.attrs?.level ?? 1))) };
    content.push(...doc.content ?? []);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!notes.length) throw new Error("Select at least one Markdown note.");
  return { document: { type: "doc", content } as JSONContent, notes: order, images: [...usedImages.values()], skipped, unresolved, imageIssues, resolvedReferences };
}
