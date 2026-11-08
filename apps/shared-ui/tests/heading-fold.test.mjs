import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./support/editor.mjs";
import { getFoldedIds } from "../src/lib/heading-fold.ts";
import { editorState, editorOutline } from "../src/editor-host/commands.ts";

for (const action of ["toggleFold", "setFolds", "foldCurrentSection"]) {
  test(`${action} clears child focus when folding its parent moves the caret outside it`, () => {
    const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: {
      type: "doc", content: [
        { type: "heading", attrs: { level: 1, "data-toc-id": "parent" }, content: [{ type: "text", text: "Parent" }] },
        { type: "heading", attrs: { level: 2, "data-toc-id": "child" }, content: [{ type: "text", text: "Child" }] },
        { type: "paragraph", content: [{ type: "text", text: "body" }] },
      ],
    } });
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    try {
      editor.commands.setTextSelection(17);
      editor.commands.showSection(8);
      assert.equal(editorState(editor).focusedSectionId, "child");
      if (action === "foldCurrentSection") editor.commands.foldCurrentSection();
      if (action === "toggleFold") editor.commands.toggleFold(0);
      else if (action === "setFolds") editor.commands.setFolds(["parent"]);
      else editor.commands.foldCurrentSection();
      assert.equal(editorState(editor).focusedSectionId, null);
      assert.ok(getFoldedIds(editor.state).includes("parent"));
      assert.equal(editorState(editor).headingId, "parent", "caret moves to the visible parent");
      assert.ok(!editorOutline(editor).some(heading => heading.id === "child"));
    } finally { editor.destroy(); }
  });
}
