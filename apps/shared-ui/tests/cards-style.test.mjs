import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

// Parse the shipped stylesheet: these declarations are the visual contract
// for real editable text, not a separate test-only rendering of the syntax.
const require = createRequire(import.meta.resolve("vite"));
const { parse } = require("postcss");
const css = parse(await readFile(new URL("../src/App.css", import.meta.url), "utf8"));
const style = (selector) => {
  const declarations = new Map();
  css.walkRules(selector, (rule) => rule.walkDecls(({ prop, value }) => declarations.set(prop, value)));
  return declarations;
};

test("cloze braces stay hidden while editing their block", () => {
  const braces = style(".tiptap .cloze-brace");
  assert.equal(Number.parseFloat(braces.get("font-size")), 0);
  assert.ok(!["none", "hidden"].includes(braces.get("display")));

  // The active-block rule must not make the braces visible again.
  const active = style(".tiptap .card-block-active .cloze-brace");
  assert.equal(Number.parseFloat(active.get("font-size") ?? braces.get("font-size")), 0);
});

test("the hidden answer is tinted and clearly underlined", () => {
  const answer = style(".tiptap .cloze-text");
  assert.equal(answer.get("border-radius"), undefined);
  assert.match(answer.get("box-shadow"), /^inset 0 -2px 0 0 /);
  assert.ok(answer.get("background-color") && answer.get("background-color") !== "transparent");
});

test("the `::` arrow is drawn without a box behind it", () => {
  const separator = style(".tiptap .card-sep");
  assert.equal(separator.get("color"), "transparent");
  assert.equal(separator.get("background-color"), undefined);
  assert.equal(separator.get("mask"), undefined);
});

test("rendered cloze math shares the tint and has a square underline", () => {
  const math = style(".tiptap .cloze-math .inline-math-widget");
  assert.equal(math.get("background-color"), style(".tiptap .cloze-text").get("background-color"));
  assert.equal(math.get("border-radius"), "0");
  assert.equal(math.get("box-shadow"), style(".tiptap .cloze-text").get("box-shadow"));
  assert.equal(style(".dark .tiptap .cloze-math .inline-math-widget").get("background-color"),
    style(".dark .tiptap .cloze-text").get("background-color"));
});


test("the card dot's list offset matches one level of list indent", () => {
  const indent = Number.parseFloat(style(".tiptap ul,\n.tiptap ol").get("padding-left")) + Number.parseFloat(style(".tiptap li").get("padding-left"));
  assert.equal(Number.parseFloat(style(".tiptap").get("--card-list-indent")), indent);
});
