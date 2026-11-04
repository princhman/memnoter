import assert from "node:assert/strict";
import { test } from "node:test";
import { findTermsFor, splitMarked } from "../src/lib/search-marks.ts";

test("snippets split into plain and marked text", () => {
  assert.deepEqual(splitMarked("a \u0002b\u0003 c \u0002d\u0003"), [
    { text: "a ", marked: false },
    { text: "b", marked: true },
    { text: " c ", marked: false },
    { text: "d", marked: true },
  ]);
  assert.deepEqual(splitMarked("<b>no markup</b>"), [{ text: "<b>no markup</b>", marked: false }]);
  assert.deepEqual(splitMarked(""), []);
});

test("find terms try the query, then the note's spelling, then single words", () => {
  assert.deepEqual(
    findTermsFor(" uber  graph ", "the \u0002Über\u0003 \u0002graphs\u0003"),
    ["uber graph", "Über", "graphs", "graph", "uber"],
  );
  assert.deepEqual(findTermsFor("x", "\u0002x\u0003"), ["x"]);
});
