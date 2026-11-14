import type { JSONContent } from "@tiptap/core";
import { mentionTarget, type MentionTarget, targetKey } from "./mention";

export type MentionNote = { headings: { id: string; title: string; path: string[]; parentId?: string | null }[]; mentions: { target: MentionTarget; mentionId: string; heading: string | null }[] };
export function extractMentions(doc: JSONContent): MentionNote {
  const result: MentionNote = { headings: [], mentions: [] };
  let heading: string | null = null;
  // Enclosing sections by heading level, so a section is named by its path.
  let open: { level: number; title: string; id: string | null }[] = [];
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join("");
  const visit = (node: JSONContent) => {
    if (node.type === "heading") {
      const id = node.attrs?.["data-toc-id"];
      heading = text(node).trim() || "Untitled section";
      const level = Number(node.attrs?.level) || 1;
      open = open.filter(section => section.level < level);
      if (typeof id === "string" && id) result.headings.push({ id, title: heading, path: open.map(section => section.title), parentId: open[open.length - 1]?.id ?? null });
      open.push({ level, title: heading, id: typeof id === "string" ? id : null });
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
export function backlinks(notes: { id: string; name: string; note: MentionNote }[], target: MentionTarget) {
  const key = targetKey(target);
  return notes.flatMap(source => source.note.mentions.filter(mention => targetKey(mention.target) === key).map(mention => ({ moduleId: source.id, moduleName: source.name, ...mention })));
}
