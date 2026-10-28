import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { extractFromDoc, extractFromYDoc } from "../src/lib/search-text.ts";

// Same node names as the editor's extensions.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    bulletList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph block*" },
    codeBlock: { group: "block", content: "text*", marks: "", code: true },
    mathBlock: { group: "block", content: "text*", marks: "", code: true },
    image: { group: "block", attrs: { fileId: { default: null } } },
    inlineMath: { group: "inline", inline: true, content: "text*", marks: "" },
    hardBreak: { group: "inline", inline: true },
    text: { group: "inline" },
  },
  marks: { bold: {}, italic: {} },
});

const n = schema.nodes;
const text = (value, ...marks) =>
  schema.text(value, marks.map((mark) => schema.marks[mark].create()));

const doc = n.doc.create(null, [
  n.heading.create({ level: 2 }, text("Fourier  series")),
  n.paragraph.create(null, [
    text("The "),
    text("bold", "bold"),
    text("er", "bold", "italic"),
    text(" part"),
    n.inlineMath.create(null, text("a_n")),
    text("is"),
    n.hardBreak.create(),
    text("next line"),
  ]),
  n.bulletList.create(null, [
    n.listItem.create(null, [n.paragraph.create(null, text("first"))]),
    n.listItem.create(null, [
      n.paragraph.create(null, text("second")),
      n.bulletList.create(null, n.listItem.create(null, n.paragraph.create(null, text("nested")))),
    ]),
  ]),
  n.paragraph.create(),
  n.image.create({ fileId: "x" }),
  n.mathBlock.create(null, text("\\sum_{n=0}^\\infty\n  a_n \\cos(nx)")),
  n.codeBlock.create(null, text("let x = 1;\nx += 2")),
]);

const expected = {
  body: [
    "Fourier series",
    "The bolder part is next line",
    "first",
    "second",
    "nested",
    "let x = 1;",
    "x += 2",
  ].join("\n"),
  math: ["a_n", "\\sum_{n=0}^\\infty", "a_n \\cos(nx)"].join("\n"),
};

test("editor documents give one line per block, with math source kept apart", () => {
  assert.deepEqual(extractFromDoc(doc), expected);
});

test("a stored Yjs document gives the same text as the editor", () => {
  const source = new Y.Doc();
  prosemirrorToYXmlFragment(doc, source.getXmlFragment("default"));
  // Load it the way backfill does: from saved bytes into a fresh document.
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(source));
  assert.deepEqual(extractFromYDoc(loaded), extractFromDoc(doc));
  assert.deepEqual(extractFromYDoc(loaded), expected);
});

test("an empty document extracts nothing", () => {
  assert.deepEqual(extractFromDoc(n.doc.create(null, n.paragraph.create())), { body: "", math: "" });
  assert.deepEqual(extractFromYDoc(new Y.Doc()), { body: "", math: "" });
});
