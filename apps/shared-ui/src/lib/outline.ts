import type { Node } from "@tiptap/pm/model";

export const UNTITLED_SECTION = "Untitled section";
export const TOC_ID_ATTRIBUTE = "data-toc-id";

export function headingId(node: Node | null | undefined): string | null {
  const id = node?.type.name === "heading" ? node.attrs[TOC_ID_ATTRIBUTE] : null;
  return typeof id === "string" && id ? id : null;
}

export type OutlineHeading = {
  pos: number;
  level: number;
  end: number;
  id: string | null;
  title: string;
  ancestors: readonly OutlineHeading[];
};

const cache = new WeakMap<Node, readonly OutlineHeading[]>();

// The schema permits headings in blockquotes, lists and table cells. Only
// document children define note sections, matching hierarchy correction,
// insertion, folding and card breadcrumbs. Nested headings remain local text.
export function outline(doc: Node): readonly OutlineHeading[] {
  const cached = cache.get(doc);
  if (cached) return cached;
  const headings: OutlineHeading[] = [];
  const stack: OutlineHeading[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()!.end = pos;
    const heading: OutlineHeading = {
      pos, level, end: doc.content.size, id: headingId(node),
      title: node.textContent.trim() || UNTITLED_SECTION,
      ancestors: [...stack],
    };
    headings.push(heading);
    stack.push(heading);
  });
  cache.set(doc, headings);
  return headings;
}
