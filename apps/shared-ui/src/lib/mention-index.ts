import type { JSONContent } from "@tiptap/core";
import { mentionTarget, type MentionTarget, targetKey } from "./mention";

export type MentionNote = { headings: { id: string; title: string }[]; mentions: { target: MentionTarget; mentionId: string; heading: string | null }[] };
export function extractMentions(doc: JSONContent): MentionNote {
  const result: MentionNote = { headings: [], mentions: [] };
  let heading: string | null = null;
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join("");
  const visit = (node: JSONContent) => {
    if (node.type === "heading") {
      const id = node.attrs?.["data-toc-id"];
      heading = text(node).trim() || "Untitled section";
      if (typeof id === "string" && id) result.headings.push({ id, title: heading });
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
