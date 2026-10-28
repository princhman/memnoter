import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { HeadingFold, getFoldedIds } from "../src/lib/heading-fold.ts";
import { SectionFocus, getFocusedSectionRange } from "../src/lib/section-focus.ts";

const schema = new Schema({ nodes: {
  doc: { content: "block+" },
  heading: { group: "block", content: "text*", attrs: { level: { default: 1 }, "data-toc-id": { default: null } } },
  paragraph: { group: "block", content: "text*" },
  text: {},
} });
const heading = (level, id, text) => schema.nodes.heading.create({ level, "data-toc-id": id }, schema.text(text));
const doc = schema.nodes.doc.create(null, [
  heading(1, "parent", "Parent"), // 0–8
  heading(2, "child", "Child"), // 8–15
  schema.nodes.paragraph.create(null, schema.text("body")), // 15–21
]);

// Test the shared folding commands with real ProseMirror state and decorations:
// the cursor must remain visible after folding an ancestor of a focused section.
for (const action of ["toggleFold", "setFolds", "foldCurrentSection"]) {
  test(`${action} clears child focus when folding its parent moves the caret outside it`, () => {
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 17), plugins: [
      ...SectionFocus.config.addProseMirrorPlugins(),
      ...HeadingFold.config.addProseMirrorPlugins(),
    ] });
    // Use the command rather than relying on the plugin key's generated name.
    const dispatch = (tr) => { state = state.applyTransaction(tr).state; };
    SectionFocus.config.addCommands().showSection(8)({ state, dispatch });
    assert.deepEqual(getFocusedSectionRange(state), { from: 8, to: 21 });
    if (action === "foldCurrentSection") {
      // First fold the child, then invoke the shortcut again to fold the parent.
      HeadingFold.config.addCommands().foldCurrentSection()({ state, dispatch });
      assert.deepEqual(getFocusedSectionRange(state), { from: 8, to: 21 });
    }
    const commands = HeadingFold.config.addCommands();
    const command = action === "toggleFold" ? commands.toggleFold(0)
      : action === "setFolds" ? commands.setFolds(["parent"])
      : commands.foldCurrentSection();
    command({ state, dispatch: (tr) => {
      // Inspect the owning transaction before appendTransaction can repair it.
      assert.equal(getFocusedSectionRange(state.apply(tr)), null);
      dispatch(tr);
    } });
    assert.equal(state.selection.head, 7);
    assert.equal(getFocusedSectionRange(state), null);
    assert.ok(getFoldedIds(state).includes("parent"));
  });
}
