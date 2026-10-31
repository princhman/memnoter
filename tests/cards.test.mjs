import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import {
  blockIdOf,
  changedRanges,
  extractCards,
  parseBlock,
  planCardIds,
} from "../src/lib/cards.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", attrs: { cardId: { default: null }, clozeIds: { default: null } } },
    heading: { group: "block", content: "inline*", attrs: { cardId: { default: null }, clozeIds: { default: null } } },
    codeBlock: { group: "block", content: "text*", code: true, marks: "" },
    blockquote: { group: "block", content: "block+" },
    inlineMath: { group: "inline", inline: true, content: "text*" },
    hardBreak: { group: "inline", inline: true },
    text: { group: "inline" },
  },
  marks: { bold: {}, code: { code: true }, link: {} },
});
const { doc, paragraph, heading, codeBlock, blockquote, inlineMath, hardBreak } = schema.nodes;

// Writes inline content: strings are text, `$..$` is inline math, `\n` is a
// hard break and `` `..` `` is inline code.
function inline(source) {
  const nodes = [];
  for (const part of source.split(/(\$[^$]+\$|`[^`]+`|\n)/)) {
    if (!part) continue;
    if (part === "\n") nodes.push(hardBreak.create());
    else if (part.startsWith("$")) nodes.push(inlineMath.create(null, schema.text(part.slice(1, -1))));
    else if (part.startsWith("`")) nodes.push(schema.text(part.slice(1, -1), [schema.marks.code.create()]));
    else nodes.push(schema.text(part));
  }
  return nodes;
}

const p = (source, cardId = null) => paragraph.create({ cardId }, inline(source));
const text = (value) => ({ type: "text", text: value });

test("basic cards split at the first spaced :: and trim both sides", () => {
  const { cards, separator } = parseBlock(p("What is $e^{i\\pi}$ ::  $-1$, by Euler "));
  assert.deepEqual(cards, [
    {
      kind: "basic",
      front: [text("What is "), { type: "math", tex: "e^{i\\pi}" }],
      back: [{ type: "math", tex: "-1" }, text(", by Euler")],
    },
  ]);
  // "What is " is 8 characters and the formula node takes 10 positions.
  assert.deepEqual(separator, { from: 19, to: 21 });

  assert.deepEqual(parseBlock(p("A :: B :: C")).cards[0].back, [text("B :: C")]);
  assert.deepEqual(parseBlock(p("Line one\nline two :: answer")).cards[0].front, [
    text("Line one"),
    { type: "break" },
    text("line two"),
  ]);
});

test("prose and code that contain :: are not cards", () => {
  for (const source of ["use std::vector here", "a::b", "x ::: y", "f `a :: b` g", ":: answer", "question ::", "  ::  "]) {
    assert.deepEqual(parseBlock(p(source)).cards, [], source);
  }
  // A recognised separator without an answer is still styled, but no card.
  assert.notEqual(parseBlock(p("question ::")).separator, null);
  assert.equal(parseBlock(p("f `a :: b` g")).separator, null);
});

test("each cloze is a card that hides only itself", () => {
  const syntax = parseBlock(p("{{Paris}} is the capital of {{France}} :: ignored"));
  assert.equal(syntax.separator, null, "a cloze block has no basic separator");
  assert.deepEqual(syntax.clozes, [
    { open: { from: 0, to: 2 }, inner: { from: 2, to: 7 }, close: { from: 7, to: 9 } },
    { open: { from: 28, to: 30 }, inner: { from: 30, to: 36 }, close: { from: 36, to: 38 } },
  ]);
  assert.deepEqual(syntax.cards, [
    {
      kind: "cloze",
      front: [{ type: "blank" }, text(" is the capital of France :: ignored")],
      back: [{ type: "cloze", children: [text("Paris")] }, text(" is the capital of France :: ignored")],
    },
    {
      kind: "cloze",
      front: [text("Paris is the capital of "), { type: "blank" }, text(" :: ignored")],
      back: [text("Paris is the capital of "), { type: "cloze", children: [text("France")] }, text(" :: ignored")],
    },
  ]);
  assert.deepEqual(parseBlock(p("Area {{$\\pi r^2$}}")).cards[0].back[1], {
    type: "cloze",
    children: [{ type: "math", tex: "\\pi r^2" }],
  });
});

test("empty, unclosed and code clozes are ignored", () => {
  for (const source of ["{{}} and {{ }}", "{{open", "close}}", "`{{code}}`"]) {
    assert.deepEqual(parseBlock(p(source)).cards, [], source);
  }
  // Without a closed cloze, the basic syntax still applies.
  assert.equal(parseBlock(p("{{open :: answer")).cards[0].kind, "basic");
  assert.deepEqual(parseBlock(p("{{a {{b}}")).cards[0].back, [
    text("{{a "),
    { type: "cloze", children: [text("b")] },
  ]);
});

test("marks are kept in card content", () => {
  const bold = schema.marks.bold.create();
  const block = paragraph.create(null, [schema.text("Q", [bold]), schema.text(" :: "), schema.text("A", [bold, schema.marks.link.create()])]);
  assert.deepEqual(parseBlock(block).cards[0], {
    kind: "basic",
    front: [{ type: "text", text: "Q", marks: ["bold"] }],
    back: [{ type: "text", text: "A", marks: ["bold"] }],
  });
});

test("extraction needs a card id, skips code blocks and numbers clozes", () => {
  const document = doc.create(null, [
    p("Q :: A", "b1"),
    p("no id :: yet"),
    heading.create({ cardId: "h1" }, inline("{{x}} and {{y}}")),
    codeBlock.create(null, schema.text("a :: b")),
    blockquote.create(null, p("Nested :: card", "q1")),
    p("Copy :: before dedupe", "b1"),
    p("no syntax", "plain"),
  ]);
  assert.deepEqual(
    extractCards(document).map(({ id, blockId, kind }) => [id, blockId, kind]),
    [
      ["b1", "b1", "basic"],
      ["h1:c1", "h1", "cloze"],
      ["h1:c2", "h1", "cloze"],
      ["q1", "q1", "basic"],
    ],
  );
  assert.equal(blockIdOf("h1:c2"), "h1");
  assert.equal(blockIdOf("b1"), "b1");
});

function counter() {
  let n = 0;
  return () => `new${++n}`;
}

function apply(document, plan) {
  const tr = new Transform(document);
  for (const { pos, cardId } of plan) tr.setNodeAttribute(pos, "cardId", cardId);
  return tr.doc;
}

test("new card blocks get ids and pasted copies are renumbered", () => {
  const original = doc.create(null, [p("Q :: A", "a"), p("plain")]);
  // Typing the syntax into a plain paragraph.
  const typed = new Transform(original).insert(14, schema.text(" :: answer"));
  const plan = planCardIds(typed.doc, changedRanges(typed.mapping.maps), counter());
  assert.deepEqual(plan, [{ pos: 8, cardId: "new1" }]);

  // Pasting a copy of the card above the original: the copy is renumbered.
  const pasted = new Transform(original).insert(0, p("Q :: A", "a"));
  const pastePlan = planCardIds(pasted.doc, changedRanges(pasted.mapping.maps), counter());
  assert.deepEqual(pastePlan, [{ pos: 0, cardId: "new1" }]);
  const after = apply(pasted.doc, pastePlan);
  assert.deepEqual(extractCards(after).map((card) => card.id), ["new1", "a"]);

  // Unchanged documents need nothing.
  assert.deepEqual(planCardIds(after, [], counter()), []);
});

test("splitting a card block keeps its id on the half with the syntax", () => {
  const original = doc.create(null, [p("Q :: A", "a")]);
  // Enter at the start of the paragraph copies its attributes to both halves.
  const split = new Transform(original).split(1);
  assert.deepEqual(split.doc.child(0).attrs.cardId, "a");
  const plan = planCardIds(split.doc, changedRanges(split.mapping.maps), counter());
  assert.deepEqual(plan, [{ pos: 0, cardId: null }]);
  assert.deepEqual(extractCards(apply(split.doc, plan)).map((card) => card.id), ["a"]);
});

test("a whole-document replace (loading) dedupes in document order", () => {
  const loaded = doc.create(null, [p("One :: 1", "a"), p("Two :: 2", "a"), p("Three :: 3")]);
  const tr = new Transform(doc.create(null, [p("")])).replaceWith(0, 2, loaded.content);
  assert.deepEqual(planCardIds(tr.doc, changedRanges(tr.mapping.maps), counter()), [
    { pos: 10, cardId: "new1" },
    { pos: 20, cardId: "new2" },
  ]);
});


test("linked delimiters stay literal content rather than creating cards", () => {
  const link = schema.marks.link.create();
  for (const source of ["https://example.com/{{slug}}", "C++ :: std"]) {
    const linked = schema.text(source, [link]);
    assert.deepEqual(parseBlock(paragraph.create(null, linked)).cards, [], source);
    const block = paragraph.create(null, [schema.text("Question :: "), linked]);
    assert.deepEqual(parseBlock(block).cards, [{
      kind: "basic", front: [text("Question")], back: [text(source)],
    }]);
  }
  // Even one linked character prevents a delimiter spanning mark boundaries.
  for (const content of [
    [schema.text("Q :"), schema.text(":", [link]), schema.text(" A")],
    [schema.text("{"), schema.text("{", [link]), schema.text("answer}}")],
    [schema.text("{{answer}"), schema.text("}", [link])],
  ]) assert.deepEqual(parseBlock(paragraph.create(null, content)).cards, []);
});


test("cloze extraction validates metadata and uses only matching active ranges", () => {
  const first = { id: "stable-first", from: 2, to: 7, answer: "Paris" };
  const second = { id: "stable-second", from: 16, to: 22, answer: "France" };
  const retired = { id: "retired", from: -1, to: -1, answer: "Paris" };
  const cases = [
    [null, ["c1", "c2"]],
    [{}, ["c1", "c2"]],
    [[null], ["c1", "c2"]],
    [[{ from: 2, to: 7, answer: "Paris" }], ["c1", "c2"]],
    [[{ ...first, from: "2" }], ["c1", "c2"]],
    [[{ ...first, to: Infinity }], ["c1", "c2"]],
    [[{ ...first, answer: null }], ["c1", "c2"]],
    [[], []],
    [[first], ["stable-first"]],
    [[retired, second, first], ["stable-first", "stable-second"]],
    [[retired, second], ["stable-second"]],
    [[{ ...first, from: 3 }], []],
  ];
  for (const [clozeIds, expected] of cases) {
    const block = paragraph.create({ cardId: "reviewed", clozeIds }, inline("{{Paris}} and {{France}}"));
    assert.deepEqual(extractCards(doc.create(null, block)).map(({ id }) => id),
      expected.map((id) => `reviewed:${id}`), JSON.stringify(clozeIds));
  }
});
