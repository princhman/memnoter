import type { Node } from "@tiptap/pm/model";
import { headingNumbers } from "./heading-numbering";
import { outline } from "./outline";

const cache = new WeakMap<Node, { continuous: Map<number, string>; byChapter: Map<number, string> }>();

export function figureNumbers(doc: Node, numbered: boolean) {
  let figures = cache.get(doc);
  if (!figures) {
    const chapters = new Map(outline(doc).filter(heading => heading.ancestors.length === 0).map(heading => [heading.pos, heading]));
    const numbers = chapters.size ? headingNumbers(doc) : new Map<number, string>();
    const continuous = new Map<number, string>();
    const byChapter = new Map<number, string>();
    let chapter: string | undefined;
    let withinChapter = 0;
    let total = 0;

    doc.descendants((node, pos) => {
      if (chapters.has(pos)) {
        chapter = numbers.get(pos);
        withinChapter = 0;
      }
      if (node.type.name !== "image" && node.type.name !== "inlineImage") return;
      continuous.set(pos, String(total + 1));
      byChapter.set(pos, chapter ? `${chapter}.${withinChapter + 1}` : String(total + 1));
      if (typeof node.attrs.caption === "string" && node.attrs.caption.trim()) {
        total++;
        withinChapter++;
      }
    });

    figures = { continuous, byChapter };
    cache.set(doc, figures);
  }
  return numbered ? figures.byChapter : figures.continuous;
}
