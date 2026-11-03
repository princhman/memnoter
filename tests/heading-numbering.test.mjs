import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { HeadingNumbering, headingNumberingKey, headingNumbers } from "../src/lib/heading-numbering.ts";
const schema = new Schema({ nodes: {
  doc: { content: "heading+" }, heading: { content: "text*", attrs: { level: { default: 1 } } }, text: {},
} });
test("chapter decorations share hierarchical numbering and never change persisted note text", () => {
  const doc = schema.node("doc", null, [1, 3, 3, 2, 1].map(level => schema.node("heading", { level }, schema.text("Title"))));
  let state = EditorState.create({ doc, plugins: HeadingNumbering.config.addProseMirrorPlugins() });
  const plugin = state.plugins[0];
  assert.equal(plugin.props.decorations(state), null);
  state = state.apply(state.tr.setMeta(headingNumberingKey, true));
  assert.deepEqual([...headingNumbers(state.doc).values()], ["1", "1.1", "1.2", "1.3", "2"]);
  assert.deepEqual(plugin.props.decorations(state).find().map(d => d.type.attrs["data-heading-number"]), ["1", "1.1", "1.2", "1.3", "2"]);
  assert.deepEqual(state.doc.toJSON(), doc.toJSON());
  state = state.apply(state.tr.setMeta(headingNumberingKey, false));
  assert.equal(plugin.props.decorations(state), null);
});
