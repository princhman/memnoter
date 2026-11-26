import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { ProsemirrorBinding, yDocToProsemirrorJSON, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { applySavedContent, type GetContentResponse } from "./content";
import { applyPendingSaves, saveQueue } from "./saves";
import { outline, TOC_ID_ATTRIBUTE, UNTITLED_SECTION } from "./outline";
import { sectionFocusKey } from "./section-focus";
import { headingNumbers, numberHeadings } from "./heading-numbering";
import { isNoteFromNewerVersion } from "./editor-schema";

export type SectionTarget = { kind: "heading"; id: string } | { kind: "legacy-heading"; itemId: Y.ID };
export type SidebarSection = { target: SectionTarget; key: string; title: string; number: string };
export type SidebarTarget = SectionTarget | { kind: "document" } | { kind: "add" };

function sectionTarget(id: string | null, getItem: () => unknown): SectionTarget | null {
  if (id) return { kind: "heading", id };
  const item = getItem();
  if (!(item instanceof Y.XmlElement)) return null;
  // Anchor to the heading element itself, independent of its text or neighbours.
  const { type: itemId } = Y.createRelativePositionFromTypeIndex(item, 0, -1);
  return itemId ? { kind: "legacy-heading", itemId } : null;
}

function sectionKey(target: SectionTarget) {
  return target.kind === "heading" ? target.id : `chapter-${target.itemId.client}-${target.itemId.clock}`;
}

export function editorFragment(state: EditorState) {
  const binding: unknown = ySyncPluginKey.getState(state)?.binding;
  return binding instanceof ProsemirrorBinding ? binding.type : null;
}

export function focusedSidebarSection(state: EditorState) {
  const pos = sectionFocusKey.getState(state);
  // Highlight the parent H1 even when a subsection was focused from Contents.
  if (pos == null) return null;
  const chapter = outline(state.doc).find(item => item.level === 1 && item.pos <= pos && item.end > pos);
  if (!chapter) return null;
  const target = sectionTarget(chapter.id, () => editorFragment(state)?.get(state.doc.resolve(chapter.pos).index()));
  return target ? sectionKey(target) : null;
}

export function liveSidebarSections(live: Node, fragment: Y.XmlFragment | null): SidebarSection[] {
  const numbers = headingNumbers(live);
  // Every numbered H1 is listed, so the sidebar never skips a chapter number.
  return outline(live).filter(item => item.level === 1).flatMap(item => {
    const target = sectionTarget(item.id, () => fragment?.get(live.resolve(item.pos).index()));
    return target ? [{ target, key: sectionKey(target), title: item.title, number: numbers.get(item.pos) ?? "" }] : [];
  });
}

export function savedSidebarSections(moduleId: string, savedContent: GetContentResponse) {
  const doc = new Y.Doc();
  try {
    applySavedContent(doc, savedContent);
    applyPendingSaves(doc, saveQueue.pending(moduleId));
    if (doc.store.pendingStructs || doc.store.pendingDs) return { kind: "incomplete" } as const;
    if (isNoteFromNewerVersion(doc)) return { kind: "newer" } as const;
    const saved: JSONContent = yDocToProsemirrorJSON(doc, "default");
    const content = saved.content ?? [];
    const seenIds = new Set<string>();
    const duplicateIds = new Set<string>();
    // The editor's TOC repairs duplicate IDs across the whole document.
    // Use Yjs identity whenever that repair could change a sidebar target.
    function collectIds(node: JSONContent) {
      if (node.type === "heading") {
        const id = node.attrs?.[TOC_ID_ATTRIBUTE];
        if (typeof id === "string" && id) {
          if (seenIds.has(id)) duplicateIds.add(id);
          seenIds.add(id);
        }
      }
      node.content?.forEach(collectIds);
    }
    collectIds(saved);
    const headings = content.flatMap((node, pos) => {
      if (node.type !== "heading") return [];
      const attr = node.attrs?.[TOC_ID_ATTRIBUTE];
      const id = typeof attr === "string" && attr ? attr : null;
      return [{ node, pos, level: Number(node.attrs?.level), id }];
    });
    const numbers = numberHeadings(headings);
    const chapters = headings.filter(({ level }) => level === 1);
    const text = (item: JSONContent): string => item.text ?? (item.content ?? []).map(text).join("");
    const blocks = doc.getXmlFragment("default").toArray();
    const sections = chapters.flatMap(({ node, pos, id }) => {
      const target = sectionTarget(id && !duplicateIds.has(id) ? id : null, () => blocks[pos]);
      return target ? [{ target, key: sectionKey(target), title: text(node).trim() || UNTITLED_SECTION, number: numbers.get(pos) ?? "" }] : [];
    });
    return { kind: "ready", sections } as const;
  } finally { doc.destroy(); }
}

export function resolveSidebarSection(state: EditorState, target: SectionTarget) {
  const chapters = outline(state.doc).filter(item => item.level === 1);
  const binding: unknown = ySyncPluginKey.getState(state)?.binding;
  let legacyNode: unknown;
  if (target.kind === "legacy-heading" && binding instanceof ProsemirrorBinding) {
    const anchor = new Y.RelativePosition(target.itemId, null, null);
    const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, binding.doc, false);
    if (resolved?.type instanceof Y.XmlElement && resolved.type.parent === binding.type) {
      legacyNode = binding.mapping.get(resolved.type);
    }
  }
  return target.kind === "heading"
    ? chapters.find(item => item.id === target.id)
    : chapters.find(item => state.doc.nodeAt(item.pos) === legacyNode);
}
