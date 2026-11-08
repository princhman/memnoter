import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./support/editor.mjs";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { tabSpacing } from "../src/lib/tab-spacing.ts";

function run(type, text, from, to, outdent = false) {
  const doc = schema.node("doc", null, [schema.node(type, null, schema.text(text))]);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  assert.equal(tabSpacing(outdent)(state, tr => { state = state.apply(tr); }), true);
  return state.doc;
}
test("prose spacing survives document serialization without changing card delimiters", () => {
  const doc = run("paragraph", "Q :: {{A}}", 3, 3);
  assert.equal(schema.nodeFromJSON(doc.toJSON()).textContent, "Q \t:: {{A}}");
});
test("code indentation handles a selection and removes at most two leading spaces per line", () => {
  assert.equal(run("codeBlock", "a\nb", 1, 4).textContent, "  a\n  b");
  assert.equal(run("codeBlock", "   a\n b", 2, 8, true).textContent, " a\nb");
  assert.equal(run("codeBlock", "ab", 2, 2).textContent, "a  b");
});
