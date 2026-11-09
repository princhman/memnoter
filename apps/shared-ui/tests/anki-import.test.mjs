import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "./support/editor.mjs";
import { extractCards } from "../src/lib/cards.ts";
import { htmlToLines, joinLines } from "../src/lib/anki-html.ts";
import { defaultSelection, deckTree, prepareAnkiImport } from "../src/lib/anki-import.ts";

const decks = [
  ["Default", 0], ["Computer Science", 0], ["Computer Science::Year 1", 0],
  ["Computer Science::Year 1::COMP0002", 0], ["Computer Science::Year 1::COMP0002::Haskell", 3], ["Computer Science::Year 1::COMP0002::C", 2],
  ["Computer Science::Year 1::COMP0003", 4], ["Computer Science::Year 1::COMP0003::Proofs", 1],
  ["Computer Science::Year 1::COMP0147", 0], ["Computer Science::Year 1::COMP0147::Chapter 10", 1], ["Computer Science::Year 1::COMP0147::Chapter 2", 1],
].map(([name, cardCount], index) => ({ id: index + 1, name, cardCount }));
const idOf = name => decks.find(deck => deck.name === name).id;

test("modules default to the level where the deck tree branches, with the deck above as the folder", () => {
  const { roles, folders } = defaultSelection(decks);
  assert.deepEqual(Object.entries(roles).filter(([, role]) => role === "module").map(([key]) => key), [
    "Computer Science::Year 1::COMP0002", "Computer Science::Year 1::COMP0003", "Computer Science::Year 1::COMP0147",
  ]);
  assert.equal(roles["Computer Science::Year 1::COMP0002::Haskell"], "heading");
  assert.equal(roles["Computer Science::Year 1::COMP0003::Proofs"], "heading");
  assert.equal(roles["Computer Science"], "skip");
  assert.equal(roles.Default, "skip");
  assert.deepEqual([...new Set(Object.values(folders))], ["Year 1"]);
});

test("a single chain of decks makes its first deck with cards the only module, with no folder", () => {
  const { roles, folders } = defaultSelection([{ id: 1, name: "A", cardCount: 0 }, { id: 2, name: "A::B", cardCount: 2 }, { id: 3, name: "A::B::C", cardCount: 1 }]);
  assert.deepEqual(roles, { A: "skip", "A::B": "module", "A::B::C": "heading" });
  assert.deepEqual(folders, { "A::B": "A" });
  assert.deepEqual(defaultSelection([{ id: 1, name: "Empty", cardCount: 0 }]).roles, { Empty: "skip" });
});

test("decks sort naturally and missing parent decks are filled in", () => {
  const tree = deckTree([{ id: 1, name: "X::Chapter 10", cardCount: 1 }, { id: 2, name: "X::Chapter 2", cardCount: 1 }]);
  assert.deepEqual(tree[0].children.map(node => node.name), ["Chapter 2", "Chapter 10"]);
  assert.equal(tree[0].total, 2);
});

test("HTML flattens to lines, math nodes and links without losing text", () => {
  const { lines, images } = htmlToLines(
    '<b>Bold</b> and <i>it</i>&nbsp;\\(x &lt; y\\)<br><ol><li>One</li><li>Two<ul><li>Sub</li></ul></li></ol>' +
    '<pre><code class="language-c">int a;\n  return a;</code></pre><img src="a b.png" alt="pic"> [sound:x.mp3]<a href="https://x.dev">link</a>');
  const plain = lines.map(line => line.map(node => node.type === "inlineMath" ? `$${node.content[0].text}$` : node.text).join("").replace(/ /g, "~"));
  assert.deepEqual(plain, ["Bold and it $x < y$", "1. One", "2. Two", "~~- Sub", "int a;", "  return a;", "link"]);
  assert.deepEqual(images, [{ src: "a b.png", alt: "pic" }]);
  assert.deepEqual(lines[0][0].marks, [{ type: "bold" }]);
  assert.deepEqual(lines[4][0].marks, [{ type: "code" }]);
  assert.deepEqual(lines[6][0].marks, [{ type: "link", attrs: { href: "https://x.dev" } }]);
  assert.equal(joinLines([[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]]).map(node => node.type).join(), "text,hardBreak,text");
});

function editorFor(document) {
  // As the real import does: the editor assigns card identities on setContent.
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }), content: { type: "doc", content: [{ type: "paragraph" }] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.commands.setContent(document);
  editor.state.doc.check();
  return editor;
}
const mask = (id, x) => ({ id, shape: "rectangle", x, y: 0.1, width: 0.2, height: 0.2 });
const basic = (deckName, front, back, extra = {}) => ({ noteId: Math.random(), deckId: idOf(deckName), notetype: "Basic", kind: "basic", front, back, extra: "", reversed: false, ...extra });
const pkg = {
  decks,
  media: ["pic.png", "diagram.svg", "scan.jpg"],
  warnings: ["1 note of type Lonely can't be imported."],
  items: [
    basic("Computer Science::Year 1::COMP0002::Haskell", "What is <b>map</b>?", "<ol><li>Applies f</li><li>to each</li></ol>"),
    basic("Computer Science::Year 1::COMP0002::Haskell", "Reversible", "Both ways", { reversed: true }),
    basic("Computer Science::Year 1::COMP0002::C", "Use std::vector? {{ x }}", "Yes<br>\\(a::b\\)", { extra: "Remember <i>this</i>" }),
    basic("Computer Science::Year 1::COMP0002::C", "Sees picture", '<img src="pic.png">'),
    basic("Computer Science::Year 1::COMP0002::C", "Bad pictures", '<img src="diagram.svg"><img src="gone.png">https://x'),
    basic("Computer Science::Year 1::COMP0002::C", "", "no front"),
    { noteId: 1, deckId: idOf("Computer Science::Year 1::COMP0003"), notetype: "Cloze", kind: "cloze", text: "If \\(f\\) is differentiable, then {{c1::f is continuous}} and {{c2::so is g::hint}}", extra: "Extra :: info" },
    { noteId: 2, deckId: idOf("Computer Science::Year 1::COMP0003::Proofs"), notetype: "IO", kind: "occlusion", image: "scan.jpg", header: "Header", extra: "", masks: [mask("a", 0.1), mask("b", 0.4), { ...mask("c", 0.7), group: "b" }] },
    { noteId: 3, deckId: idOf("Computer Science::Year 1::COMP0003::Proofs"), notetype: "IO", kind: "occlusion", image: "missing.jpg", header: "", extra: "", masks: [mask("a", 0.1)] },
    { noteId: 4, deckId: idOf("Computer Science::Year 1::COMP0147::Chapter 2"), notetype: "Lonely", kind: "unsupported" },
  ],
};
const selection = defaultSelection(decks);

test("modules convert to documents the real editor accepts, with the cards that were written", () => {
  const plan = prepareAnkiImport(pkg, selection);
  assert.deepEqual(plan.modules.map(module => [module.name, module.folder, module.cards]), [["COMP0002", "Year 1", 6], ["COMP0003", "Year 1", 4]]);
  assert.deepEqual(plan.images, ["pic.png", "scan.jpg"]);

  const c0002 = editorFor(plan.modules[0].document);
  try {
    const headings = [];
    c0002.state.doc.forEach(node => { if (node.type.name === "heading") headings.push([node.attrs.level, node.textContent]); });
    assert.deepEqual(headings, [[1, "C"], [1, "Haskell"]]);
    const cards = extractCards(c0002.state.doc);
    assert.deepEqual(cards.map(card => [card.kind, card.section.join("/")]), [
      ["basic", "C"], ["basic", "C"], ["basic", "C"],
      ["basic", "Haskell"], ["basic", "Haskell"], ["basic", "Haskell"],
    ]);
    const text = segments => segments.map(segment => segment.type === "math" ? `$${segment.tex}$` : segment.type === "break" ? "\n" : segment.text ?? "").join("");
    const [firstC] = cards;
    assert.equal(text(firstC.front), "Use std::vector? {​{ x }}", "colons and braces in the question stay prose");
    assert.equal(text(firstC.back), "Yes\n$a::b$\n\nRemember this");
    const map = cards.find(card => text(card.front) === "What is map?");
    assert.equal(text(map.back), "1. Applies f\n2. to each");
    assert.deepEqual(cards.filter(card => card.id.endsWith(":reverse")).length, 1);
    const images = [];
    c0002.state.doc.descendants(node => { if (node.type.name === "image") images.push(node.attrs.fileId); });
    assert.deepEqual(images, ["pic.png"], "an image-only answer keeps its picture beside the card");
    assert.equal(text(cards[1].back), "(image)");
  } finally { c0002.destroy(); }

  const c0003 = editorFor(plan.modules[1].document);
  try {
    const cards = extractCards(c0003.state.doc);
    assert.deepEqual(cards.map(card => card.kind), ["cloze", "cloze", "occlusion", "occlusion"]);
    assert.equal(cards[0].back.find(segment => segment.type === "cloze").children[0].text, "f is continuous");
    assert.deepEqual(cards.slice(2).map(card => card.section), [["Proofs"], ["Proofs"]], "masks joined by group are one card");
    const image = [];
    c0003.state.doc.descendants(node => { if (node.type.name === "image") image.push(node.attrs); });
    assert.equal(image.length, 1);
    assert.equal(image[0].fileId, "scan.jpg");
    assert.equal(image[0].masks.length, 3);
  } finally { c0003.destroy(); }
});

test("warnings explain what could not come across and unselected decks stay out", () => {
  const plan = prepareAnkiImport(pkg, selection);
  assert.deepEqual(plan.warnings, [
    "1 note of type Lonely can't be imported.",
    "Images inside cards are placed below the card. (2)",
    "Images in SVG format can't be imported.",
    "An image the notes refer to is missing from the package.",
    "A card with an empty front or back was skipped.",
    "An image with hidden regions is missing from the package.",
    "COMP0147 has no cards that could be imported, so it was left out.",
  ]);
  const only = prepareAnkiImport(pkg, { roles: { ...selection.roles, "Computer Science::Year 1::COMP0003": "skip" }, names: { "Computer Science::Year 1::COMP0002": " Programming " }, folders: { "Computer Science::Year 1::COMP0002": null } });
  assert.deepEqual(only.modules.map(module => [module.name, module.folder]), [["Programming", null]]);
});

test("merge puts a subdeck's cards in its parent's section and heading levels nest", () => {
  const roles = { ...selection.roles, "Computer Science::Year 1::COMP0002::C": "merge", "Computer Science::Year 1::COMP0002::Haskell": "heading" };
  const plan = prepareAnkiImport(pkg, { roles });
  const doc = plan.modules[0].document.content;
  assert.equal(doc[0].type, "paragraph", "merged cards come before the headings");
  assert.deepEqual(doc.filter(node => node.type === "heading").map(node => node.content[0].text), ["Haskell"]);
  const nested = prepareAnkiImport({ ...pkg, decks: [...decks, { id: 99, name: "Computer Science::Year 1::COMP0002::Haskell::Monads", cardCount: 1 }], items: [...pkg.items, { ...basic("Computer Science::Year 1::COMP0002::Haskell", "Q", "A"), deckId: 99 }] },
    { roles: { ...selection.roles, "Computer Science::Year 1::COMP0002::Haskell::Monads": "heading" } });
  assert.deepEqual(nested.modules[0].document.content.filter(node => node.type === "heading").map(node => [node.attrs.level, node.content[0].text]), [[1, "C"], [1, "Haskell"], [2, "Monads"]]);
});

test("joined clozes and supplied identities survive the real editor and map Anki templates", () => {
  const schedule = { kind: "new", suspended: false, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, reviews: [] };
  const source = { decks: [{ id: 1, name: "Deck", cardCount: 5 }], media: ["scan.jpg"], warnings: [], items: [
    { noteId: 1, deckId: 1, notetype: "Cloze", kind: "cloze", text: "{{c3::a}} and {{c3::b}} then {{c8::c}}", extra: "", cards: [{ ...schedule, ord: 2 }, { ...schedule, ord: 7 }] },
    { noteId: 2, deckId: 1, notetype: "Basic", kind: "basic", front: "Q", back: "A", extra: "", reversed: true, cards: [{ ...schedule, ord: 0 }, { ...schedule, ord: 1 }] },
    { noteId: 3, deckId: 1, notetype: "IO", kind: "occlusion", image: "scan.jpg", header: "", extra: "", masks: [mask("a", 0.1), { ...mask("b", 0.4), group: "a" }], cards: [{ ...schedule, ord: 0, mask: "a" }] },
  ] };
  const plan = prepareAnkiImport(source, defaultSelection(source.decks));
  const module = plan.modules[0];
  const editor = editorFor(module.document);
  try {
    const cards = extractCards(editor.state.doc);
    assert.equal(cards.length, 5);
    assert.deepEqual(cards.map(c => c.id), module.histories.map(h => h.cardId));
    assert.equal(module.histories[0].anki.ord, 2);
    assert.ok(cards[0].id.endsWith(":c1"));
    assert.ok(cards[1].id.endsWith(":c3"));
    assert.equal(cards.filter(c => c.kind === "cloze").length, 2);
  } finally { editor.destroy(); }
});

test("a cloze blank holding only an image does not shift the other blanks' histories", () => {
  const schedule = { kind: "new", suspended: false, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, reviews: [] };
  const source = { decks: [{ id: 1, name: "Deck", cardCount: 2 }], media: ["pic.png"], warnings: [], items: [
    { noteId: 1, deckId: 1, notetype: "Cloze", kind: "cloze", text: '{{c1::<img src="pic.png">}} and {{c2::text answer}}', extra: "", cards: [{ ...schedule, ord: 0 }, { ...schedule, ord: 1 }] },
  ] };
  const module = prepareAnkiImport(source, defaultSelection(source.decks)).modules[0];
  assert.deepEqual(module.histories.map(h => h.anki.ord), [1]);
});
