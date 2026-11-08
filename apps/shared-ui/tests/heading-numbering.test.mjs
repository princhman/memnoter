import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./support/editor.mjs";
import { EditorState } from "@tiptap/pm/state";
import { HeadingNumbering, headingNumberingKey, headingNumbers } from "../src/lib/heading-numbering.ts";

test("chapter decorations share hierarchical numbering and never change persisted note text", () => {
  const doc = schema.node("doc", null, [1, 3, 3, 2, 1].map(level => schema.node("heading", { level }, schema.text("Title"))));
  let state = EditorState.create({ doc, plugins: HeadingNumbering.config.addProseMirrorPlugins() });
  const plugin = state.plugins[0];
  assert.equal(plugin.props.decorations(state), null);
  state = state.apply(state.tr.setMeta(headingNumberingKey, true));
  assert.deepEqual([...headingNumbers(state.doc).values()], ["1", "1.1", "1.2", "1.3", "2"]);
  const decorations = plugin.props.decorations(state).find();
  // Read the rendered labels without needing a global browser document.
  const view = { dom: { ownerDocument: { createElement: () => ({ setAttribute() {} }) } } };
  assert.deepEqual(decorations.map(d => d.type.toDOM(view).textContent), ["1\u00a0", "1.1\u00a0", "1.2\u00a0", "1.3\u00a0", "2\u00a0"]);
  assert.deepEqual(state.doc.toJSON(), doc.toJSON());
  state = state.apply(state.tr.setMeta(headingNumberingKey, false));
  assert.equal(plugin.props.decorations(state), null);
});
