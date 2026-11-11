import assert from "node:assert/strict";
import { test } from "node:test";
import { schema } from "./support/editor.mjs";
import {
  blockIdOf,
  cardIdsOf,
  extractCards,
  parseBlock,
} from "../src/lib/cards.ts";


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
  const { cards } = parseBlock(p("What is $e^{i\\pi}$ ::  $-1$, by Euler "));
  assert.deepEqual(cards, [
    {
      kind: "basic",
      front: [text("What is "), { type: "math", tex: "e^{i\\pi}" }],
      back: [{ type: "math", tex: "-1" }, text(", by Euler")],
    },
  ]);

  assert.deepEqual(parseBlock(p("A :: B :: C")).cards[0].back, [text("B :: C")]);
  assert.deepEqual(parseBlock(p("Line one\nline two :: answer")).cards[0].front, [
    text("Line one"),
    { type: "break" },
    text("line two"),
  ]);
});

test("prose and code that contain :: are not cards", () => {
  for (const source of ["use std::vector here", "a::b", "a:::b", "x :::: y", "x ::::: y", "f `a :: b` g", ":: answer", "question ::", "  ::  "]) {
    assert.deepEqual(parseBlock(p(source)).cards, [], source);
  }
  // A recognised separator without an answer is still styled, but no card.
  assert.notEqual(parseBlock(p("question ::")).separator, null);
  assert.equal(parseBlock(p("f `a :: b` g")).separator, null);
});

test("two-way cards keep forward history and have stable, distinct reverse ids", () => {
  const one = extractCards(doc.create(null, [p("Front :: Back", "stable")]));
  const block = p("Front ::: Back", "stable");
  const both = extractCards(doc.create(null, [block]));
  assert.deepEqual(both.map(({ id }) => id), ["stable", "stable:reverse"]);
  assert.deepEqual(both.map(({ kind }) => kind), ["basic", "basic"]);
  assert.deepEqual(both[0].front, one[0].front);
  assert.deepEqual(both[1].front, one[0].back);
  assert.deepEqual(both[1].back, one[0].front);
  assert.deepEqual(cardIdsOf(block), [{ id: "stable", answer: "Forward" }, { id: "stable:reverse", answer: "Reverse" }]);
  assert.equal(blockIdOf(both[1].id), "stable");
  assert.deepEqual(extractCards(doc.create(null, [p("Front :: Back", "stable")])), one);
  assert.deepEqual(extractCards(doc.create(null, [block])), both);
  assert.deepEqual(parseBlock(p("Front `:::` Back")).cards, []);
  assert.equal(parseBlock(p("{{Front}} ::: Back")).cards[0].kind, "cloze");
  const forged = paragraph.create({ cardId: "stable", clozeIds: [{ from: 2, to: 7, id: "reverse", answer: "Front" }] }, inline("{{Front}}"));
  assert.equal(cardIdsOf(forged)[0].id, "stable:c1", "reverse is reserved outside the cloze namespace");
  assert.deepEqual(parseBlock(p("A\nB ::: C\nD")).cards[1].front, [text("C"), { type: "break" }, text("D")]);
});

test("each cloze is a card that hides only itself", () => {
  const syntax = parseBlock(p("{{Paris}} is the capital of {{France}} :: ignored"));
  assert.equal(syntax.separator, null, "a cloze block has no basic separator");
  assert.deepEqual(syntax.cards, [
    {
      kind: "cloze",
      front: [{ type: "blank" }, text(" is the capital of "), { type: "hidden", children: [text("France")] }, text(" :: ignored")],
      back: [{ type: "cloze", children: [text("Paris")] }, text(" is the capital of France :: ignored")],
    },
    {
      kind: "cloze",
      front: [{ type: "hidden", children: [text("Paris")] }, text(" is the capital of "), { type: "blank" }, text(" :: ignored")],
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

test("each card records the headings it sits under", () => {
  const h = (level, text, cardId = null) => heading.create({ level, cardId }, inline(text));
  const document = doc.create(null, [
    p("Top :: card", "t"),
    h(1, "Logic"),
    h(2, "Predicate logic"),
    blockquote.create(null, p("Nested :: card", "n")),
    h(2, "Term :: definition", "hc"),
    p("Under :: heading card", "u"),
    h(1, "Sets"),
    p("Next :: chapter", "s"),
  ]);
  assert.deepEqual(
    Object.fromEntries(extractCards(document).map(({ id, section }) => [id, section])),
    {
      t: [],
      n: ["Logic", "Predicate logic"],
      // A heading card belongs to its parents, and titles the blocks below it.
      hc: ["Logic"],
      u: ["Logic", "Term :: definition"],
      s: ["Sets"],
    },
  );
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


test("card colours survive adjacent runs, clozes and inline math", () => {
  const mark = color => schema.marks.highlight.create({ color });
  const block = paragraph.create({ cardId: "colours" }, [
    schema.text("Q :: {{"), schema.text("blue", [mark("blue")]),
    schema.text("pink", [mark("pink")]),
    inlineMath.create(null, schema.text("x"), [mark("purple")]), schema.text("}}"),
  ]);
  const [card] = extractCards(doc.create(null, block));
  assert.deepEqual(card.back, [
    { type: "text", text: "Q :: " },
    { type: "cloze", children: [
      { type: "text", text: "blue", marks: ["highlight"], highlightColor: "blue" },
      { type: "text", text: "pink", marks: ["highlight"], highlightColor: "pink" },
      { type: "math", tex: "x", highlightColor: "purple" },
    ] },
  ]);
});

test("each cloze of a note is its own card that shows the whole note", () => {
  const { mathBlock, orderedList, listItem } = schema.nodes;
  const member = (source, cardId) => paragraph.create({ cardId, clozeNote: "n" }, inline(source));
  const cards = extractCards(doc.create(null, [
    member("The derivation is", "intro"),
    mathBlock.create(null, schema.text("a + b")),
    p("And {{x}}. So:", "and"),
    orderedList.create(null, [
      listItem.create(null, [p("if {{y}}", "one")]),
      listItem.create(null, [member("then {{z}}", "two")]),
    ]),
    p("Alone {{w}}", "alone"),
  ]));
  const block = (children, place = {}) => ({ type: "block", children, ...place });
  const hidden = (value) => ({ type: "hidden", children: [text(value)] });
  assert.deepEqual(cards.map(({ id }) => id), ["and:c1", "one:c1", "two:c1", "alone:c1"]);
  assert.deepEqual(cards[1].front, [
    block([text("The derivation is")]),
    block([{ type: "math", tex: "a + b", display: true }]),
    block([text("And "), hidden("x"), text(". So:")]),
    block([text("if "), { type: "blank" }], { depth: 1, marker: 1 }),
    block([text("then "), hidden("z")], { depth: 1, marker: 2 }),
  ]);
  assert.deepEqual(cards[1].back[3], block([text("if "), { type: "cloze", children: [text("y")] }], { depth: 1, marker: 1 }));
  assert.deepEqual(cards[1].back[4], block([text("then z")], { depth: 1, marker: 2 }));
  // A block outside the note keeps its own card text.
  assert.deepEqual(cards[3].front, [text("Alone "), { type: "blank" }]);
  // A heading ends a note, even one added between its members later.
  const split = extractCards(doc.create(null, [
    member("A {{a}}", "a"), heading.create({ level: 2 }, schema.text("H")), member("B {{b}}", "b"),
  ]));
  assert.deepEqual(split[1].front, [text("B "), { type: "blank" }]);
});

test("a formula can be a cloze, and a foldable block can be a note as a whole", () => {
  const { mathBlock, details, detailsSummary, detailsContent } = schema.nodes;
  const math = (tex, attrs = {}) => mathBlock.create(attrs, schema.text(tex));
  // A formula's braces are LaTeX, not clozes.
  assert.deepEqual(extractCards(doc.create(null, [math("\\frac{{a}}{b}", { cardId: "plain" })])), []);
  const alone = extractCards(doc.create(null, [math("e^{i\\pi}", { cardId: "euler", cloze: true })]));
  assert.deepEqual(alone.map(({ id, front, back }) => ({ id, front, back })), [{
    id: "euler:math",
    front: [{ type: "blank" }],
    back: [{ type: "cloze", children: [{ type: "math", tex: "e^{i\\pi}", display: true }] }],
  }]);
  assert.deepEqual(cardIdsOf(math("e^{i\\pi}", { cardId: "euler", cloze: true })), [{
    id: "euler:math", answer: "e^{i\\pi}", parts: [{ type: "math", tex: "e^{i\\pi}", display: true }],
  }]);

  const block = (children, place = {}) => ({ type: "block", children, ...place });
  const cards = extractCards(doc.create(null, [
    details.create({ open: true, clozeNote: "proof" }, [
      detailsSummary.create(null, schema.text("Proof")),
      detailsContent.create(null, [
        p("Step {{one}}", "step"),
        math("a = b", { cardId: "formula", cloze: true }),
      ]),
    ]),
    p("Outside {{two}}", "outside"),
  ]));
  assert.deepEqual(cards.map(({ id }) => id), ["step:c1", "formula:math", "outside:c1"]);
  assert.deepEqual(cards[1].front, [
    block([text("Proof")]),
    block([text("Step "), { type: "hidden", children: [text("one")] }]),
    block([{ type: "blank" }]),
  ]);
  assert.deepEqual(cards[0].back[2], block([{ type: "math", tex: "a = b", display: true }]));
  assert.deepEqual(cards[2].front, [text("Outside "), { type: "blank" }]);
});
