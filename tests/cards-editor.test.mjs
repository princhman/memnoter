import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { joinBackward } from "@tiptap/pm/commands";
import StarterKit from "@tiptap/starter-kit";
import { Flashcards } from "../src/lib/flashcards.ts";
import { blockIdOf, extractCards } from "../src/lib/cards.ts";

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

const paragraph = (text, cardId = null, clozeIds = null) => ({
  type: "paragraph",
  attrs: { cardId, clozeIds },
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

const clozeCards = (editor) => new Map(extractCards(editor.state.doc).map((card) => [
  card.back.find((segment) => segment.type === "cloze").children.map((segment) => segment.text).join(""),
  card.id,
]));

test("legacy clozes retain their answer identities through prepend, removal, reorder and reload", () => {
  const editor = editorFor([paragraph("{{Paris}} and {{France}}", "reviewed")]);
  let reloaded;
  try {
    const original = clozeCards(editor);
    assert.equal(original.get("Paris"), "reviewed:c1");
    assert.equal(original.get("France"), "reviewed:c2");
    editor.commands.insertContentAt(1, { type: "text", text: "{{Earth}} and " });
    const earth = clozeCards(editor).get("Earth");
    assert.equal(clozeCards(editor).get("Paris"), original.get("Paris"));
    assert.equal(clozeCards(editor).get("France"), original.get("France"));
    assert.ok(![...original.values()].includes(earth));

    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.deleteRange({ from: 15, to: 29 });
    assert.deepEqual(clozeCards(editor), new Map([["Earth", earth], ["France", original.get("France")]]));
    editor.commands.undo();
    assert.equal(clozeCards(editor).get("Paris"), original.get("Paris"));

    // A whole-block reorder also occurs with cut/paste and external edits.
    editor.commands.insertContentAt({ from: 1, to: editor.state.doc.firstChild.nodeSize - 1 },
      { type: "text", text: "{{France}} and {{Paris}} and {{Earth}}" });
    assert.deepEqual(clozeCards(editor), new Map([
      ["France", original.get("France")], ["Paris", original.get("Paris")], ["Earth", earth],
    ]));
    reloaded = editorFor(editor.getJSON().content);
    assert.deepEqual(clozeCards(reloaded), clozeCards(editor));
    reloaded.commands.insertContentAt(1, { type: "text", text: "{{Moon}} and " });
    assert.equal(clozeCards(reloaded).get("France"), original.get("France"));
    assert.equal(clozeCards(reloaded).get("Paris"), original.get("Paris"));
    assert.equal(clozeCards(reloaded).get("Earth"), earth);
  } finally {
    reloaded?.destroy();
    editor.destroy();
  }
});

test("mapped cloze identity survives answer edits and duplicate answers get separate identities", () => {
  const editor = editorFor([paragraph("{{Paris}} and {{Paris}}", "reviewed")]);
  try {
    editor.commands.insertContentAt(1, { type: "text", text: "{{Paris}} and " });
    const ids = extractCards(editor.state.doc).map(({ id }) => id);
    assert.deepEqual(ids.slice(1), ["reviewed:c1", "reviewed:c2"]);
    assert.equal(new Set(ids).size, 3);
    editor.commands.insertContentAt({ from: 17, to: 22 }, { type: "text", text: "London" });
    assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), ids);
    assert.equal(clozeCards(editor).get("London"), "reviewed:c1");

    const copied = editor.getJSON().content[0];
    editor.commands.insertContentAt(0, copied);
    const cards = extractCards(editor.state.doc);
    assert.equal(new Set(cards.map(({ id }) => id)).size, 6);
    assert.deepEqual(cards.slice(3).map(({ id }) => id), ids);
    editor.commands.renewCardIds(["reviewed"]);
    const renewed = extractCards(editor.state.doc).slice(3);
    assert.ok(renewed.every(({ id }) => !ids.includes(id)));
    assert.equal(new Set(renewed.map(({ blockId }) => blockId)).size, 1);
  } finally {
    editor.destroy();
  }
});

for (const source of ["Q :: A", "{{Paris}} and {{France}}"])
  test(`joining a reviewed ${source.includes("{{") ? "cloze" : "basic"} into a plain paragraph retains its identity`, () => {
    const editor = editorFor([paragraph("Context "), paragraph(source, "reviewed")]);
    try {
      const original = extractCards(editor.state.doc).map(({ id }) => id);
      editor.commands.setTextSelection(editor.state.doc.firstChild.nodeSize + 1);
      assert.equal(joinBackward(editor.state, editor.view.dispatch), true);
      assert.equal(editor.state.doc.childCount, 1);
      assert.equal(editor.state.doc.textContent, `Context ${source}`);
      assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), original);
      editor.commands.undo();
      assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), original);
    } finally {
      editor.destroy();
    }
  });


test("removing legacy clozes never reuses their ids for later additions", () => {
  const editor = editorFor([paragraph("{{Paris}} and {{France}}", "reviewed")]);
  try {
    editor.commands.deleteRange({ from: 1, to: 15 });
    assert.deepEqual(clozeCards(editor), new Map([["France", "reviewed:c2"]]));
    editor.commands.insertContentAt({ from: 1, to: editor.state.doc.firstChild.nodeSize - 1 },
      { type: "text", text: "plain text" });
    assert.deepEqual(extractCards(editor.state.doc), []);
    editor.commands.insertContentAt(1, { type: "text", text: "{{Earth}} " });
    const id = clozeCards(editor).get("Earth");
    assert.ok(!["reviewed:c1", "reviewed:c2"].includes(id));
    assert.equal(blockIdOf(id), "reviewed");
  } finally {
    editor.destroy();
  }
});

test("a persisted cloze keeps its identity across a split and backward join", () => {
  const editor = editorFor([paragraph("{{Paris}} and {{France}}", "reviewed")]);
  try {
    editor.commands.insertContentAt(1, { type: "text", text: "{{Earth}} and " });
    const original = clozeCards(editor);
    editor.commands.setTextSelection(1);
    editor.commands.splitBlock();
    assert.deepEqual(clozeCards(editor), original);
    editor.commands.setTextSelection(3);
    assert.equal(joinBackward(editor.state, editor.view.dispatch), true);
    assert.deepEqual(clozeCards(editor), original);
  } finally {
    editor.destroy();
  }
});


test("cutting and pasting a cloze within its block keeps its review identity", () => {
  const editor = editorFor([paragraph("{{Paris}} and {{France}}", "reviewed")]);
  try {
    editor.commands.deleteRange({ from: 1, to: 15 });
    editor.commands.insertContentAt(editor.state.doc.firstChild.nodeSize - 1,
      { type: "text", text: " and {{Paris}}" });
    assert.deepEqual(clozeCards(editor), new Map([["France", "reviewed:c2"], ["Paris", "reviewed:c1"]]));
  } finally {
    editor.destroy();
  }
});


test("editing malformed or incomplete cloze metadata repairs it without borrowing retired ids", () => {
  const first = { id: "first", from: 2, to: 7, answer: "Paris" };
  const retired = { id: "retired", from: -1, to: -1, answer: "deleted" };
  for (const metadata of [{}, [null], [{ from: 2, to: 7, answer: "Paris" }],
    [], [first], [retired, first]]) {
    const editor = editorFor([paragraph("{{Paris}} and {{France}}", "reviewed", metadata)]);
    try {
      editor.commands.insertContentAt(5, { type: "text", text: "!" });
      const cards = clozeCards(editor);
      assert.equal(cards.size, 2);
      assert.ok([...cards.values()].every((id) => !id.endsWith(":undefined") && id !== "reviewed:retired"));
      if (Array.isArray(metadata) && metadata.includes(first)) {
        assert.equal(cards.get("Pa!ris"), "reviewed:first");
      }
      assert.equal(new Set(cards.values()).size, 2);
    } finally {
      editor.destroy();
    }
  }
});

test("HTML cloze metadata parsing rejects valid JSON with an invalid shape", () => {
  const editor = editorFor([paragraph("{{Paris}}", "reviewed")]);
  try {
    const rule = editor.schema.nodes.paragraph.spec.parseDOM.find(({ tag }) => tag === "p");
    for (const value of ["{}", "[null]", '[{"from":2,"to":7,"answer":"Paris"}]', "broken-json"]) {
      const attrs = rule.getAttrs({ getAttribute: (name) => name === "data-cloze-ids" ? value : null });
      assert.equal(attrs.clozeIds ?? null, null, value);
    }
    const attrs = rule.getAttrs({ getAttribute: (name) => name === "data-cloze-ids" ? "[]" : null });
    assert.deepEqual(attrs.clozeIds, []);
  } finally {
    editor.destroy();
  }
});

for (const source of ["Q :: A", "{{Paris}} and {{France}}"])
  test(`joining a ${source.includes("{{") ? "cloze" : "basic"} replaces a plain destination's stale id but preserves an active card's id`, () => {
    for (const destinationIsCard of [false, true]) {
      const editor = editorFor([paragraph("Context :: answer ", "former"), paragraph(source, "reviewed")]);
      try {
        if (!destinationIsCard) {
          editor.commands.insertContentAt({ from: 1, to: editor.state.doc.firstChild.nodeSize - 1 },
            { type: "text", text: "Context " });
          assert.equal(editor.state.doc.firstChild.attrs.cardId, "former");
        }
        const original = extractCards(editor.state.doc).map(({ id }) => id);
        editor.view.dispatch(closeHistory(editor.state.tr));
        editor.commands.setTextSelection(editor.state.doc.firstChild.nodeSize + 1);
        assert.equal(joinBackward(editor.state, editor.view.dispatch), true);
        const cards = extractCards(editor.state.doc);
        assert.ok(cards.length > 0);
        assert.ok(cards.every(({ blockId }) => blockId === (destinationIsCard ? "former" : "reviewed")));
        if (!destinationIsCard) assert.deepEqual(cards.map(({ id }) => id), original);
        editor.commands.undo();
        assert.deepEqual(extractCards(editor.state.doc).map(({ id }) => id), original);
      } finally {
        editor.destroy();
      }
    }
  });

test("local edits leave distant legacy cloze metadata untouched while repairing every edited block", () => {
  const editor = editorFor([
    paragraph("{{Paris}}", "first"),
    paragraph("Spacer one"),
    paragraph("{{Untouched}}", "distant"),
    paragraph("Spacer two"),
    paragraph("{{France}}", "last"),
  ]);
  try {
    const last = editor.state.doc.content.size - editor.state.doc.lastChild.nodeSize;
    // Two disjoint changes in one transaction exercise both mapped range sets.
    editor.view.dispatch(editor.state.tr.insertText("!", last + 5).insertText("!", 5));
    assert.equal(editor.state.doc.child(2).attrs.clozeIds, null);
    assert.equal(editor.state.doc.firstChild.attrs.clozeIds[0].answer, "Pa!ris");
    assert.equal(editor.state.doc.lastChild.attrs.clozeIds[0].answer, "Fr!ance");
    assert.deepEqual([...clozeCards(editor).values()], ["first:c1", "distant:c1", "last:c1"]);
  } finally {
    editor.destroy();
  }
});
