import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { outline } from "../src/lib/outline.ts";

const schema = new Schema({ nodes: {
  doc: { content: "block*" },
  heading: { group: "block", content: "text*", attrs: { level: {}, "data-toc-id": { default: null } } },
  paragraph: { group: "block", content: "text*" },
  blockquote: { group: "block", content: "block*" },
  text: {},
} });
const h = (level, title, id = null) => schema.nodes.heading.create({ level, "data-toc-id": id }, title ? schema.text(title) : null);
const p = () => schema.nodes.paragraph.create();

test("sections end at the next peer or ancestor, including skipped levels and empty titles", () => {
  const nodes = [p(), h(1, "  Root  ", "root"), h(3, "  "), p(), h(2, "Child"), h(1, "Next")];
  const doc = schema.nodes.doc.create(null, nodes);
  const positions = []; doc.forEach((_, pos) => positions.push(pos));
  const headings = outline(doc);
  assert.deepEqual(headings.map(({ pos, level, end, id, title, ancestors }) => ({
    pos, level, end, id, title, ancestors: ancestors.map(h => h.title),
  })), [
    { pos: positions[1], level: 1, end: positions[5], id: "root", title: "Root", ancestors: [] },
    { pos: positions[2], level: 3, end: positions[4], id: null, title: "Untitled section", ancestors: ["Root"] },
    { pos: positions[4], level: 2, end: positions[5], id: null, title: "Child", ancestors: ["Root"] },
    { pos: positions[5], level: 1, end: doc.content.size, id: null, title: "Next", ancestors: [] },
  ]);
});

test("nested headings do not create note sections and edits refresh titles and ranges", () => {
  const nested = schema.nodes.blockquote.create(null, [h(1, "Local"), p()]);
  const doc = schema.nodes.doc.create(null, [h(2, "Outer"), nested, p()]);
  assert.deepEqual(outline(doc).map(h => [h.title, h.end]), [["Outer", doc.content.size]]);
  const edited = schema.nodes.doc.create(null, [h(2, "Changed"), nested, h(1, "Peer")]);
  assert.deepEqual(outline(edited).map(h => h.title), ["Changed", "Peer"]);
  assert.equal(outline(doc)[0].title, "Outer");
  assert.deepEqual(outline(schema.nodes.doc.create()).map(h => h.title), []);
});
