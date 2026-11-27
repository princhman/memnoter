import type { JSONContent } from "@tiptap/core";
import { parsePdfSource } from "./pdf-quote";
import { mentionPage, mentionTarget, targetKey } from "./mention";

type Target = NonNullable<ReturnType<typeof mentionTarget>>;

export type MentionNote = { headings: { id: string; title: string; path: string[]; parentId?: string | null }[]; images: { id: string; title: string }[]; mentions: { target: Target; mentionId: string; heading: string | null }[] };
export function extractMentions(doc: JSONContent): MentionNote {
  const result: MentionNote = { headings: [], images: [], mentions: [] };
  let heading: string | null = null;
  let imageNumber = 0;
  // Enclosing sections by heading level, so a section is named by its path.
  let open: { level: number; title: string; id: string | null }[] = [];
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join("");
  const visit = (node: JSONContent) => {
    if (node.type === "heading") {
      const id = node.attrs?.["data-toc-id"];
      imageNumber = 0;
      heading = text(node).trim() || "Untitled section";
      const level = Number(node.attrs?.level) || 1;
      open = open.filter(section => section.level < level);
      if (typeof id === "string" && id) result.headings.push({ id, title: heading, path: open.map(section => section.title), parentId: open[open.length - 1]?.id ?? null });
      open.push({ level, title: heading, id: typeof id === "string" ? id : null });
    }
    if (node.type === "image" || node.type === "inlineImage") {
      imageNumber++;
      const id = node.attrs?.imageId;
      if (typeof id === "string" && id) {
        const title = node.attrs?.title;
        const source = parsePdfSource(node.attrs?.pdfSource);
        const caption = typeof title === "string" && title.trim() || (source && `${source.name}, page ${source.page}`);
        result.images.push({ id, title: caption || [heading, `Image ${imageNumber}`].filter(Boolean).join(" / ") });
      }
    }
    if (node.type === "mention") {
      const target = mentionTarget(node.attrs?.target);
      const mentionId = node.attrs?.mentionId;
      if (target && typeof mentionId === "string") result.mentions.push({ target, mentionId, heading });
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return result;
}
export function backlinks(notes: { id: string; name: string; note: MentionNote }[], target: Target) {
  const key = targetKey(target);
  return notes.flatMap(source => source.note.mentions.filter(mention => targetKey(mention.target) === key).map(mention => ({ moduleId: source.id, moduleName: source.name, ...mention })));
}

export type MentionBankItem = { kind: "question" | "worksheet"; moduleId: string; id: string; title: string };

/** Display label computed live so it follows target renames and deletions. */
export function mentionLabel(notes: { id: string; name: string; note: MentionNote }[], files: { id: string; name: string; pageCount?: number | null }[], target: Target, bankItems: MentionBankItem[] = []): string | undefined {
  if (target.kind === "file") return files.find(file => file.id === target.id)?.name;
  if (target.kind === "pdf-page") {
    const file = files.find(file => file.id === target.id);
    const page = mentionPage(target.locator);
    return file && page && (file.pageCount == null || page <= file.pageCount) ? `${file.name} p.${page}` : undefined;
  }
  if (target.kind === "question" || target.kind === "worksheet") {
    return bankItems.find(item => item.kind === target.kind && item.moduleId === target.id && item.id === target.nodeId)?.title;
  }
  const module = notes.find(note => note.id === target.id);
  if (target.kind === "module") return module?.name;
  if (target.kind === "image") {
    const image = module?.note.images.find(image => image.id === target.nodeId);
    return module && image ? `${module.name} › ${image.title}` : undefined;
  }
  if (target.kind !== "heading") return undefined;
  const heading = module?.note.headings.find(item => item.id === target.nodeId);
  return module && heading ? `${module.name} › ${[...(heading.path ?? []), heading.title].join(" / ")}` : undefined;
}
