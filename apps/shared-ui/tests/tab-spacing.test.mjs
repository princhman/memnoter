import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./support/editor.mjs";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./support/editor.mjs";

function run(type, text, from, to, outdent = false) {
  const doc = schema.node("doc", null, [schema.node(type, null, schema.text(text))]);
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: doc.toJSON() });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    editor.commands.setTextSelection({ from, to });
    const handled = editor.state.plugins.some(plugin => plugin.props.handleKeyDown?.(editor.view, {
      key: "Tab", keyCode: 9, shiftKey: outdent, preventDefault() {},
    }));
    assert.equal(handled, true);
    return editor.state.doc;
  } finally { editor.destroy(); }
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
