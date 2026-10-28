import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Flashcards } from "../src/lib/flashcards.ts";
import { extractCards } from "../src/lib/cards.ts";

// Exercise real Tiptap commands and appendTransaction without mounting a DOM.
function editorFor(content) {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit, Flashcards],
    content: { type: "doc", content },
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

const paragraph = (text, cardId = null) => ({
  type: "paragraph",
  attrs: { cardId },
  content: [{ type: "text", text }],
});

test("Enter before a card retains its review identity and paste assigns a new identity", () => {
  const editor = editorFor([paragraph("Q :: A", "original")]);
  try {
    editor.commands.setTextSelection(1);
    editor.commands.splitBlock();
    assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), ["original"]);
    assert.equal(editor.state.doc.firstChild.attrs.cardId, null);

    editor.commands.insertContentAt(0, paragraph("Q :: A", "original"));
    const ids = extractCards(editor.state.doc).map(({ id }) => id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], "original");
    assert.equal(ids[1], "original");
    editor.commands.undo();
    assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), ["original"]);
  } finally {
    editor.destroy();
  }
});

test("Make card wraps the selection, assigns an id and undoes as a text edit", () => {
  const editor = editorFor([paragraph("A  Paris  B")]);
  try {
    editor.commands.setTextSelection({ from: 2, to: 11 });
    assert.equal(editor.commands.makeCloze(), true);
    assert.equal(editor.state.doc.textContent, "A  {{Paris}}  B");
    const [card] = extractCards(editor.state.doc);
    assert.ok(card.id.endsWith(":c1"));
    assert.deepEqual(card.front, [
      { type: "text", text: "A  " },
      { type: "blank" },
      { type: "text", text: "  B" },
    ]);
    editor.commands.undo();
    assert.equal(editor.state.doc.textContent, "A  Paris  B");
    assert.deepEqual(extractCards(editor.state.doc), []);
  } finally {
    editor.destroy();
  }
});
