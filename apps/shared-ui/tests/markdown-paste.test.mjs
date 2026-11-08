import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { markdownToJSON, looksLikeMarkdown } from "../src/lib/markdown-paste.ts";

const t = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", content });
const mark = type => ({ type });
function all(node, type) { return [...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap(n => all(n, type))]; }

test("conservative detection leaves normal prose, currency, unpaired and escaped markup alone", () => {
  for (const value of ["A normal sentence.", "Two lines\nof normal prose", "$5", "$5.00", "It costs $5 and $10 today", "$5$", "#tags", "snake_case_name", "2 * 3 = 6", "a > b", "unmatched **bold", String.raw`\# Title`, String.raw`\*literal\*`]) {
    assert.equal(looksLikeMarkdown(value), false, value);
  }
  for (const value of ["# Title", "- item", "1. first", "> quote", "**bold**", "_italic_", "~~gone~~", "`code`", "==yellow==", "$x_y$", "$$x$$", "[[Note]]", "%%hidden%%", "text ^abc123", "---", "Title\n====", "|a|b|\n|-|-|\n|1|2|"]) {
    assert.equal(looksLikeMarkdown(value), true, value);
  }
});

test("standard blocks and inline marks produce exact schema-independent JSON", () => {
  assert.deepEqual(markdownToJSON('# Title\n\n**bold** *italic* ~~gone~~ `code` [site](https://example.com)\n\n---\n\n```js\nconst a = 1;\n```'), doc(
    { type: "heading", attrs: { level: 1 }, content: [t("Title")] },
    p(t("bold", [mark("bold")]), t(" "), t("italic", [mark("italic")]), t(" "), t("gone", [mark("strike")]), t(" "), t("code", [mark("code")]), t(" "), t("site", [{ type: "link", attrs: { href: "https://example.com" } }])),
    { type: "horizontalRule" }, { type: "codeBlock", attrs: { language: "js" }, content: [t("const a = 1;")] },
  ));
  assert.deepEqual(markdownToJSON("3. first\n   - nested\n4. second"), doc({ type: "orderedList", attrs: { start: 3 }, content: [
    { type: "listItem", content: [p(t("first")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("nested"))] }] }] },
    { type: "listItem", content: [p(t("second"))] },
  ] }));
  assert.deepEqual(markdownToJSON("> quote\n>\n> another"), doc({ type: "blockquote", content: [p(t("quote")), p(t("another"))] }));
});

test("tables wrap header and ordinary cells in paragraphs", () => {
  assert.deepEqual(markdownToJSON("| Name | Value |\n|:---|---:|\n| **a** | 2 |"), doc({ type: "table", content: [
    { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("Name"))] }, { type: "tableHeader", content: [p(t("Value"))] }] },
    { type: "tableRow", content: [{ type: "tableCell", content: [p(t("a", [mark("bold")]))] }, { type: "tableCell", content: [p(t("2"))] }] },
  ] }));
});

test("LaTeX is exact text in editable math nodes and currency stays text", () => {
  const latex = String.raw`\frac{x_y}{\alpha} + a_b + \text{==raw== %%literal%%}`;
  assert.deepEqual(markdownToJSON(`$${latex}$\n\n$$\n${latex}\n+ z\n$$`), doc(
    p({ type: "inlineMath", content: [t(latex)] }), { type: "mathBlock", content: [t(`${latex}\n+ z`)] },
  ));
  assert.deepEqual(markdownToJSON("before $$x_y$$ after"), doc(p(t("before ")), { type: "mathBlock", content: [t("x_y")] }, p(t(" after"))));
  assert.deepEqual(markdownToJSON("$$x_y$$"), doc({ type: "mathBlock", content: [t("x_y")] }));
  assert.deepEqual(markdownToJSON("Costs $5 and $10."), doc(p(t("Costs $5 and $10."))));
});

test("Obsidian links, callouts, tasks, highlights, tags and metadata have readable output", () => {
  assert.deepEqual(markdownToJSON("---\ntitle: Private\n---\n[[Note]] [[Note|alias]] [[Note#Heading]] #tags ==yellow== %%secret%% ^abc123"), doc(p(
    t("Note alias Note #tags "), t("yellow", [{ type: "highlight", attrs: { color: "yellow" } }]),
  )));
  assert.deepEqual(markdownToJSON("> [!note] Title\n> body"), doc({ type: "blockquote", content: [p(t("Title", [mark("bold")]), t("\n"), t("body"))] }));
  assert.deepEqual(markdownToJSON("- [ ] pending\n- [x] done"), doc({ type: "bulletList", content: [
    { type: "listItem", content: [p(t("☐ pending"))] }, { type: "listItem", content: [p(t("☑ done"))] },
  ] }));
  assert.deepEqual(markdownToJSON("%%comment\n\nmore%%"), doc(p()));
});

test("code spans and fences protect all Obsidian rewrites", () => {
  const raw = "==keep== [[Note]] $x_y$ %%comment%% ^abc123";
  assert.deepEqual(markdownToJSON('`' + raw + '`\n\n```text\n' + raw + '\n```'), doc(p(t(raw, [mark("code")])), { type: "codeBlock", attrs: { language: "text" }, content: [t(raw)] }));
});

test("rewrites also preserve indented code and code or math nested inside highlights", () => {
  const raw = "==raw== %%keep%% [[Note]] ^id";
  assert.deepEqual(markdownToJSON("    " + raw), doc({ type: "codeBlock", attrs: { language: null }, content: [t(raw)] }));
  const highlighted = markdownToJSON('==before `==literal==` $x_y$ after==');
  assert.equal(all(highlighted, "inlineMath")[0].content[0].text, "x_y");
  assert.ok(all(highlighted, "text").some(n => n.text === "==literal==" && n.marks.some(m => m.type === "code")));
});

test("local images and note embeds become separate placeholders; remote images become links", () => {
  assert.deepEqual(markdownToJSON("![[photo.png]]\n\n![[photo.png|300]]\n\n![[Other note]]\n\n![alt](path/photo.png)\n\n![alt](https://example.com/photo.png)"), doc(
    p(t("[image: photo.png]")), p(t("[image: photo.png]")), p(t("[embed: Other note]")), p(t("[image: photo.png]")), p(t("alt", [{ type: "link", attrs: { href: "https://example.com/photo.png" } }])),
  ));
  assert.deepEqual(markdownToJSON("before ![[photo.png]] after"), doc(p(t("before ")), p(t("[image: photo.png]")), p(t(" after"))));
});

test("realistic 200-line note preserves headings, cards, math and literal source in bounded time", () => {
  const source = readFileSync(new URL("./fixtures/obsidian-study-note.md", import.meta.url), "utf8");
  assert.equal(source.trimEnd().split("\n").length, 200);
  const started = performance.now();
  const result = markdownToJSON(source);
  assert.ok(performance.now() - started < 1000, "200 lines should parse well below one second");
  assert.deepEqual(all(result, "heading").map(n => n.attrs.level), [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(all(result, "inlineMath").length, 10);
  assert.equal(all(result, "mathBlock").length, 10);
  assert.equal(all(result, "table").length, 10);
  const words = all(result, "text").map(n => n.text).join("\n");
  assert.ok(words.includes("What powers recall? :: Retrieval practice"));
  assert.ok(words.includes("{{active recall}}"));
  assert.ok(words.includes("==literal== %%keep%%"));
  assert.ok(!words.includes("PRIVATE"));
});

test("inline math inside an Obsidian highlight keeps the highlight", () => {
  const [math] = all(markdownToJSON("==before $x$ after=="), "inlineMath");
  assert.deepEqual(math.marks, [{ type: "highlight", attrs: { color: "yellow" } }]);
  assert.equal(all(markdownToJSON("plain $x$"), "inlineMath")[0].marks, undefined);
});

test("Obsidian one-line cards on consecutive lines become separate paragraphs", () => {
  const item = all(markdownToJSON("- Unsatisfiable ::: $v$ for none\nValid ::: $v$ for all"), "listItem")[0];
  assert.deepEqual(item.content.map(p => p.type), ["paragraph", "paragraph"]);
  assert.match(item.content[1].content[0].text, /^Valid ::: $/);
  // Hard breaks (two trailing spaces or a backslash) separate cards too.
  for (const source of ["A :: B  \nC :: D", "A :: B\\\nC :: D"]) {
    assert.equal(markdownToJSON(source).content.length, 2, source);
  }
  // Ordinary multi-line prose, clozes and `std::vector` keep their single paragraph.
  for (const source of ["first line\nsecond line", "a {{b}} :: c\nd", "use std::vector\nhere"]) {
    assert.equal(markdownToJSON(source).content.length, 1, source);
  }
});
