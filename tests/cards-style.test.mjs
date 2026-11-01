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

test("cloze braces take no room until the caret's block shows them", () => {
  const braces = style(".tiptap .cloze-brace");
  assert.equal(Number.parseFloat(braces.get("font-size")), 0);
  assert.ok(!["none", "hidden"].includes(braces.get("display")));

  // Where the caret is, they are real text again and can be edited.
  const active = style(".tiptap .card-block-active .cloze-brace");
  assert.equal(active.get("font-size"), "inherit");
  assert.notEqual(active.get("color"), "transparent");
});

test("the hidden answer is tinted and clearly underlined", () => {
  const answer = style(".tiptap .cloze-text");
  assert.equal(answer.get("text-decoration-line"), "underline");
  assert.ok(Number.parseFloat(answer.get("text-decoration-thickness")) >= 2);
  assert.ok(answer.get("background-color") && answer.get("background-color") !== "transparent");
});

test("the `::` arrow is drawn without a box behind it", () => {
  const separator = style(".tiptap .card-sep");
  assert.equal(separator.get("color"), "transparent");
  assert.equal(separator.get("background-color"), undefined);
  assert.equal(separator.get("mask"), undefined);
});
