import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { schema } from "./support/editor.mjs";
import { foldableBlockReveal } from "../src/lib/foldable-block.ts";

const { details, detailsSummary, detailsContent, paragraph, heading } = schema.nodes;
const block = (open) => details.create({ open }, [
  detailsSummary.create(null, schema.text("Example")), // 1–10
  detailsContent.create(null, paragraph.create(null, schema.text("body"))), // 10–18
]);
const doc = schema.nodes.doc.create(null, [block(false), paragraph.create(null, schema.text("after"))]);
const stateAt = (pos) => EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos), plugins: [foldableBlockReveal()] });
const move = (state, pos) => state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, pos))).state;

test("a folded block opens when the caret moves into its content, not onto its title", () => {
  const after = stateAt(doc.content.size - 1);
  assert.equal(move(after, 4).doc.firstChild.attrs.open, false, "title stays folded");
  assert.equal(move(after, 13).doc.firstChild.attrs.open, true, "content opens");
});

test("the note schema keeps whether a block is open, and keeps headings out", () => {
  // Every editor of a note shares this schema; a missing attribute would be dropped on sync.
  assert.equal(block(true).attrs.open, true);
  assert.equal(detailsContent.validContent(schema.nodes.doc.create(null, heading.create({ level: 2 }, schema.text("x"))).content), false);
  assert.ok(detailsContent.validContent(block(false).content.child(1).content));
});
