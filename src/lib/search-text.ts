import type { Node } from "@tiptap/pm/model";
import * as Y from "yjs";

// Bump when the extracted text changes, so stored notes are indexed again.
export const EXTRACTOR_VERSION = 1;

export type SearchText = { body: string; math: string };

// Node names whose text is LaTeX source. It goes to its own column, so a
// formula's commands do not crowd out prose in search snippets.
const MATH_NODES = new Set(["inlineMath", "mathBlock"]);
// Elements inside a line; everything else starts a new line.
const INLINE_NODES = new Set(["inlineMath", "hardBreak", "inlineImage"]);

// The two document shapes the extractor reads: a ProseMirror node from a live
// editor, and the Yjs XML tree that Collaboration stores. Both are walked by
// the same code, so the editor and backfill produce identical text.
type Tree<N> = {
  // null for a text run
  name(node: N): string | null;
  text(node: N): string;
  children(node: N): N[];
};

const proseMirrorTree: Tree<Node> = {
  name: (node) => (node.isText ? null : node.type.name),
  text: (node) => node.text ?? "",
  children: (node) => {
    const children: Node[] = [];
    node.forEach((child) => children.push(child));
    return children;
  },
};

type YNode = Y.XmlElement | Y.XmlText | Y.XmlFragment;

const yTree: Tree<YNode> = {
  name: (node) =>
    node instanceof Y.XmlText
      ? null
      : node instanceof Y.XmlElement
        ? node.nodeName
        : "doc",
  // toString() would render marks as XML tags; the delta has the plain text.
  text: (node) =>
    (node as Y.XmlText)
      .toDelta()
      .map((op: { insert?: unknown }) =>
        typeof op.insert === "string" ? op.insert : "",
      )
      .join(""),
  children: (node) =>
    node instanceof Y.XmlText ? [] : (node.toArray() as YNode[]),
};

function extract<N>(tree: Tree<N>, root: N): SearchText {
  let body = "";
  const math: string[] = [];

  const visit = (node: N) => {
    const name = tree.name(node);
    if (name === null) {
      body += tree.text(node);
      return;
    }
    const separator = INLINE_NODES.has(name) ? " " : "\n";
    if (MATH_NODES.has(name)) {
      math.push(collectText(tree, node));
      body += separator;
      return;
    }
    body += separator;
    for (const child of tree.children(node)) visit(child);
    body += separator;
  };
  for (const child of tree.children(root)) visit(child);

  return { body: tidy(body), math: math.map(tidy).filter(Boolean).join("\n") };
}

function collectText<N>(tree: Tree<N>, node: N): string {
  if (tree.name(node) === null) return tree.text(node);
  return tree
    .children(node)
    .map((child) => collectText(tree, child))
    .join("");
}

// One line per block, single spaces, no blank lines.
function tidy(text: string) {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractFromDoc(doc: Node): SearchText {
  return extract(proseMirrorTree, doc);
}

export function extractFromYDoc(doc: Y.Doc): SearchText {
  // Collaboration's default field.
  return extract<YNode>(yTree, doc.getXmlFragment("default"));
}
