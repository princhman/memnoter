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

test("cloze braces are invisible with a visible caret and the answer has a faint tint", () => {
  const braces = style(".tiptap .cloze-brace");
  assert.equal(braces.get("color"), "transparent");
  assert.ok(braces.get("caret-color") && braces.get("caret-color") !== "transparent");
  assert.ok(!["none", "hidden"].includes(braces.get("display")));
  assert.notEqual(braces.get("visibility"), "hidden");
  assert.notEqual(Number.parseFloat(braces.get("font-size")), 0);

  const answer = style(".tiptap .cloze-text");
  assert.equal(answer.get("text-decoration-style"), "dotted");
  assert.ok(answer.get("background-color") && answer.get("background-color") !== "transparent");
});
