import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { joinBackward } from "@tiptap/pm/commands";
import StarterKit from "@tiptap/starter-kit";
import { Flashcards } from "../src/lib/flashcards.ts";
import { MathBlock } from "../src/lib/math-block.ts";
import { blockIdOf, cardIdsOf, extractCards } from "../src/lib/cards.ts";

// Exercise real Tiptap commands and appendTransaction without mounting a DOM.
function editorFor(content) {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit, MathBlock, Flashcards],
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

test("Cloze wraps the selection, assigns an id and undoes as a text edit", () => {
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

test("Remove cloze unwraps the cloze around the selection instead of nesting braces", () => {
  const editor = editorFor([paragraph("A {{Paris}} B")]);
  try {
    // Selecting the answer, as the bubble menu needs, offers removal only.
    editor.commands.setTextSelection({ from: 5, to: 10 });
    assert.equal(editor.can().makeCloze(), false);
    assert.equal(editor.commands.removeCloze(), true);
    assert.equal(editor.state.doc.textContent, "A Paris B");
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), "Paris");
    assert.deepEqual(extractCards(editor.state.doc), []);
    assert.equal(editor.commands.removeCloze(), false);
    editor.commands.undo();
    assert.equal(editor.state.doc.textContent, "A {{Paris}} B");
  } finally {
    editor.destroy();
  }
});

test("card info names the same cards that are synced", () => {
  const editor = editorFor([paragraph("Q :: A", "basic"), paragraph("{{one}} and {{two}}", "cloze")]);
  try {
    const shown = [];
    editor.state.doc.forEach((node) => shown.push(...cardIdsOf(node).map(({ id }) => id)));
    assert.deepEqual(shown, extractCards(editor.state.doc).map(({ id }) => id));
    assert.deepEqual(cardIdsOf(editor.state.doc.child(1)).map(({ answer }) => answer), ["one", "two"]);
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

test("cloze repair retains only the 20 most recently retired identities", () => {
  const editor = editorFor([paragraph("{{answer-0}}", "reviewed")]);
  try {
    const ids = new Set(["reviewed:c1"]);
    for (let i = 1; i <= 25; i++) {
      editor.commands.insertContentAt({ from: 1, to: editor.state.doc.firstChild.nodeSize - 1 },
        { type: "text", text: `{{answer-${i}}}` });
      const [card] = extractCards(editor.state.doc);
      assert.ok(!ids.has(card.id));
      ids.add(card.id);
    }
    const entries = editor.state.doc.firstChild.attrs.clozeIds;
    assert.equal(entries.length, 21);
    assert.equal(entries[0].answer, "answer-25");
    assert.deepEqual(entries.slice(1).map(({ answer, from, to }) => [answer, from, to]),
      Array.from({ length: 20 }, (_, i) => [`answer-${24 - i}`, -1, -1]));
  } finally {
    editor.destroy();
  }
});

test("copied HTML excludes retired answers and preserves the initialized empty marker", () => {
  const active = { id: "active", from: 2, to: 7, answer: "Paris" };
  const retired = { id: "retired", from: -1, to: -1, answer: "deleted private answer" };
  const editor = editorFor([paragraph("{{Paris}}", "reviewed", [active, retired])]);
  let reloaded;
  try {
    const type = editor.schema.nodes.paragraph;
    const [, attrs] = type.spec.toDOM(editor.state.doc.firstChild);
    assert.deepEqual(JSON.parse(attrs["data-cloze-ids"]), [active]);
    assert.ok(!JSON.stringify(attrs).includes(retired.answer));
    const [, emptyAttrs] = type.spec.toDOM(type.create({ cardId: "reviewed", clozeIds: [retired] }));
    assert.equal(emptyAttrs["data-cloze-ids"], "[]");
    const rule = type.spec.parseDOM.find(({ tag }) => tag === "p");
    const parsed = rule.getAttrs({ getAttribute: (name) => emptyAttrs[name] ?? null });
    reloaded = editorFor([{ ...paragraph("plain"), attrs: parsed }]);
    reloaded.commands.insertContentAt(1, { type: "text", text: "{{Earth}} " });
    const [card] = extractCards(reloaded.state.doc);
    assert.equal(card.blockId, "reviewed");
    assert.notEqual(card.id, "reviewed:c1");
  } finally {
    reloaded?.destroy();
    editor.destroy();
  }
});

test("arrow keys cross hidden cloze markers in one step without requesting page scrolling", () => {
  const editor = editorFor([paragraph("A {{word}} Z")]);
  const handlers = Flashcards.config.addProseMirrorPlugins().filter((plugin) => plugin.props.handleKeyDown);
  const arrow = (key, shiftKey = false) => handlers.some((plugin) =>
    plugin.props.handleKeyDown.call(plugin, editor.view, {
      key, shiftKey, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
    }));
  let scrolled = false;
  editor.on("transaction", ({ transaction }) => { scrolled ||= transaction.scrolledIntoView; });
  try {
    // Positions are document offsets: A {{word}} Z.
    for (const [from, key, to] of [
      [3, "ArrowRight", 6], [5, "ArrowLeft", 2],
      [9, "ArrowRight", 12], [11, "ArrowLeft", 8],
      [4, "ArrowRight", 6], [10, "ArrowLeft", 8],
      // Landing on a boundary must also bypass native caret scrolling.
      [2, "ArrowRight", 3], [8, "ArrowRight", 9],
      [6, "ArrowLeft", 5], [12, "ArrowLeft", 11],
    ]) {
      editor.commands.setTextSelection(from);
      assert.equal(arrow(key), true);
      assert.equal(editor.state.selection.head, to);
    }
    editor.commands.setTextSelection(3);
    assert.equal(arrow("ArrowRight", true), true);
    assert.equal(editor.state.selection.anchor, 3);
    assert.equal(editor.state.selection.head, 6);
    assert.equal(editor.state.doc.textContent, "A {{word}} Z");
    assert.equal(scrolled, false);
  } finally {
    editor.destroy();
  }
});

test("joining selected clozes hides them together, preserves the first identity, and undoes", () => {
  const editor = editorFor([paragraph("A {{one}} with {{two}} and {{three}}", "joined")]);
  let reloaded;
  try {
    const original = extractCards(editor.state.doc);
    editor.commands.setTextSelection({ from: 5, to: 20 });
    assert.equal(editor.can().joinClozes(), true);
    assert.equal(editor.commands.joinClozes(), true);
    const joined = extractCards(editor.state.doc);
    assert.equal(joined.length, 2);
    assert.equal(joined[0].id, original[0].id);
    assert.equal(joined[1].id, original[2].id);
    assert.deepEqual(joined[0].front, [
      { type: "text", text: "A " }, { type: "blank" },
      { type: "text", text: " with " }, { type: "blank" },
      { type: "text", text: " and " }, { type: "hidden", children: [{ type: "text", text: "three" }] },
    ]);
    assert.deepEqual(joined[0].back.filter((part) => part.type === "cloze").map((part) => part.children), [
      [{ type: "text", text: "one" }], [{ type: "text", text: "two" }],
    ]);
    assert.equal(editor.state.doc.textContent, "A {{one}} with {{two}} and {{three}}");
    assert.deepEqual(cardIdsOf(editor.state.doc.firstChild).map(({ id }) => id), joined.map(({ id }) => id));
    assert.equal(editor.can().joinClozes(), false);
    reloaded = editorFor(editor.getJSON().content);
    reloaded.commands.insertContentAt(1, { type: "text", text: "Prefix " });
    assert.deepEqual(extractCards(reloaded.state.doc).map(({ id }) => id), joined.map(({ id }) => id));
    assert.equal(extractCards(reloaded.state.doc)[0].front.filter((part) => part.type === "blank").length, 2);
    editor.commands.undo();
    assert.deepEqual(extractCards(editor.state.doc), original);
    editor.commands.redo();
    assert.deepEqual(extractCards(editor.state.doc), joined);
  } finally {
    editor.destroy();
    reloaded?.destroy();
  }
});

test("joining an existing group with another cloze produces one card", () => {
  const editor = editorFor([paragraph("{{one}} {{two}} {{three}}", "group")]);
  try {
    editor.commands.setTextSelection({ from: 3, to: 13 });
    editor.commands.joinClozes();
    editor.commands.setTextSelection({ from: 11, to: 22 });
    assert.equal(editor.commands.joinClozes(), true);
    const cards = extractCards(editor.state.doc);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, "group:c1");
    assert.equal(cards[0].front.filter((part) => part.type === "blank").length, 3);
    editor.commands.setTextSelection(4);
    assert.equal(editor.can().joinClozes(), false);
  } finally {
    editor.destroy();
  }
});

test("making a cloze note shares its text across its cards, keeps their ids, and splits", () => {
  const editor = editorFor([
    paragraph("Context", "intro"),
    paragraph("A {{one}}", "first"),
    paragraph("B {{two}}", "second"),
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Other" }] },
    paragraph("C {{three}}", "third"),
  ]);
  try {
    const original = extractCards(editor.state.doc);
    const end = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + editor.state.doc.child(2).nodeSize;
    editor.commands.setTextSelection({ from: 2, to: end + 3 });
    assert.equal(editor.can().makeClozeNote(), false, "a note never spans a heading");
    editor.commands.setTextSelection({ from: 2, to: end - 2 });
    assert.equal(editor.commands.makeClozeNote(), true);
    const notes = [0, 1, 2].map((i) => editor.state.doc.child(i).attrs.clozeNote);
    assert.ok(notes[0] && notes.every((id) => id === notes[0]));
    assert.equal(editor.can().makeClozeNote(), false, "already one note");
    const cards = extractCards(editor.state.doc);
    assert.deepEqual(cards.map(({ id }) => id), original.map(({ id }) => id));
    assert.deepEqual(cards[1].front.map((block) => block.type), ["block", "block", "block"]);
    assert.deepEqual(cards[2], original[2]);
    editor.commands.splitClozeNote(notes[0]);
    assert.deepEqual(extractCards(editor.state.doc), original);
  } finally {
    editor.destroy();
  }
});

test("Cloze in a formula makes the whole formula one card, and removing it keeps its id", () => {
  const editor = editorFor([{ type: "mathBlock", content: [{ type: "text", text: "a^2 + b^2" }] }]);
  try {
    editor.commands.setTextSelection(2);
    assert.equal(editor.can().removeCloze(), false);
    assert.equal(editor.commands.makeCloze(), true);
    const [card] = extractCards(editor.state.doc);
    assert.equal(card.kind, "cloze");
    assert.equal(card.id, `${editor.state.doc.firstChild.attrs.cardId}:math`);
    assert.equal(editor.state.doc.textContent, "a^2 + b^2");
    assert.equal(editor.commands.removeCloze(), true);
    assert.deepEqual(extractCards(editor.state.doc), []);
    editor.commands.makeCloze();
    assert.equal(extractCards(editor.state.doc)[0].id, card.id);
    // A formula cloze is enough for a note.
    editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Context" }] });
    editor.commands.setTextSelection({ from: 2, to: editor.state.doc.content.size - 2 });
    assert.equal(editor.commands.makeClozeNote(), true);
    assert.equal(extractCards(editor.state.doc)[0].front.length, 2);
  } finally {
    editor.destroy();
  }
});
