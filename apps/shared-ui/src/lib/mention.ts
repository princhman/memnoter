import { Plugin } from "@tiptap/pm/state";
import { Node, mergeAttributes } from "@tiptap/core";

// The locator is deliberately opaque here: future page/image/block targets can
// use the same envelope without changing the persisted node's attributes.
export type MentionTarget = { kind: string; id: string; nodeId: string | null; locator: string | null };
export function mentionTarget(value: unknown): MentionTarget | null {
  if (!value || typeof value !== "object" || !("kind" in value) || !("id" in value)) return null;
  if (typeof value.kind !== "string" || typeof value.id !== "string" || !value.id) return null;
  const nodeId = "nodeId" in value ? value.nodeId : null;
  const locator = "locator" in value ? value.locator : null;
  if ((nodeId !== null && typeof nodeId !== "string") || (locator !== null && typeof locator !== "string")) return null;
  return { kind: value.kind, id: value.id, nodeId, locator };
}
export const targetKey = (target: MentionTarget) => JSON.stringify([target.kind, target.id, target.nodeId, target.locator]);
export const Mention = Node.create({
  name: "mention", group: "inline", inline: true, atom: true,
  addAttributes() {
    return {
      target: { default: null, parseHTML: element => { try { return mentionTarget(JSON.parse(element.getAttribute("data-target") ?? "null")); } catch { return null; } }, renderHTML: attrs => ({ "data-target": JSON.stringify(attrs.target) }) },
      mentionId: { default: null },
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(tr => tr.docChanged)) return null;
        const seen = new Set<string>();
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "mention") return;
          const id = node.attrs.mentionId;
          if (typeof id === "string" && id && !seen.has(id)) seen.add(id);
          else {
            const mentionId = crypto.randomUUID(); seen.add(mentionId);
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, mentionId });
          }
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
  parseHTML: () => [{ tag: "span[data-mention]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-mention": "", class: "mention-chip" }), "@reference"],
  renderText: () => "@reference",
});
