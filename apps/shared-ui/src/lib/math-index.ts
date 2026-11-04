import type { Node } from "@tiptap/pm/model";

type MathInfo = { pos: number; size: number; tex: string };

export function createMathIndex(name: string) {
  let previous: Node | undefined;
  let indexed: MathInfo[] = [];
  function scan(doc: Node, from: number, to: number) {
    const formulas: MathInfo[] = [];
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === name) {
        formulas.push({ pos, size: node.nodeSize, tex: node.textContent });
        return false;
      }
      return true;
    });
    return formulas;
  }

  return function collect(doc: Node): MathInfo[] {
    if (!previous) {
      indexed = scan(doc, 0, doc.content.size);
    } else {
      const start = previous.content.findDiffStart(doc.content);
      if (start !== null) {
        const end = previous.content.findDiffEnd(doc.content)!;
        // Repeated characters can make the two diff boundaries overlap.
        const overlap = Math.max(0, start - Math.min(end.a, end.b));
        const oldEnd = end.a + overlap;
        const newEnd = end.b + overlap;
        const from = Math.max(0, start - 1);
        const oldTo = Math.min(previous.content.size, oldEnd + 1);
        const newTo = Math.min(doc.content.size, newEnd + 1);
        const delta = doc.content.size - previous.content.size;
        // Keep formulas outside the changed range, shifting the suffix rather
        // than traversing every paragraph again. Include boundary neighbors so
        // insertions, deletions, and edits inside a formula refresh whole nodes.
        const before = indexed.filter((formula) => formula.pos + formula.size <= from);
        const after = indexed
          .filter((formula) => formula.pos >= oldTo)
          .map((formula) => ({ ...formula, pos: formula.pos + delta }));
        indexed = [...before, ...scan(doc, from, newTo), ...after];
      }
    }
    previous = doc;
    return indexed;
  };
}
