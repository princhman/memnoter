import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { createMathIndex } from "../src/lib/math-index.ts";

test("formula positions and source stay correct after insertion, deletion, source edits, and block moves", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      blockquote: { group: "block", content: "block+" },
      inlineMath: { group: "inline", inline: true, content: "text*" },
      text: { group: "inline" },
    },
  });
  const { doc, paragraph, blockquote, inlineMath } = schema.nodes;
  const base = doc.create(null, [
    paragraph.create(null, [schema.text("abc"), inlineMath.create(null, schema.text("x")), schema.text("z")]),
    blockquote.create(null, paragraph.create(null, [schema.text("q"), inlineMath.create(null, schema.text("ab"))])),
    paragraph.create(null, schema.text("tail")),
  ]);
  const collect = createMathIndex("inlineMath");
  const cases = [
    [base, [{ pos: 4, size: 3, tex: "x" }, { pos: 12, size: 4, tex: "ab" }]],
    [new Transform(base).insert(2, schema.text("hello")).doc,
      [{ pos: 9, size: 3, tex: "x" }, { pos: 17, size: 4, tex: "ab" }]],
    [new Transform(base).insert(5, schema.text("y")).doc,
      [{ pos: 4, size: 4, tex: "yx" }, { pos: 13, size: 4, tex: "ab" }]],
    [new Transform(base).delete(4, 7).doc, [{ pos: 9, size: 4, tex: "ab" }]],
    [new Transform(base).insert(1, inlineMath.create(null, schema.text("new"))).doc,
      [{ pos: 1, size: 5, tex: "new" }, { pos: 9, size: 3, tex: "x" }, { pos: 17, size: 4, tex: "ab" }]],
    [doc.create(null, [base.child(1), base.child(0), base.child(2)]),
      [{ pos: 3, size: 4, tex: "ab" }, { pos: 13, size: 3, tex: "x" }]],
    [doc.create(null, paragraph.create()), []],
  ];
  for (const [document, expected] of cases) {
    assert.deepEqual(collect(document), expected);
  }
  assert.deepEqual(collect(base), cases[0][1], "later edits must not mutate cached positions");
  const repeated = doc.create(null, paragraph.create(null, inlineMath.create(null, schema.text("aaa"))));
  assert.deepEqual(collect(repeated), [{ pos: 1, size: 5, tex: "aaa" }]);
  const longer = new Transform(repeated).insert(2, schema.text("a")).doc;
  assert.deepEqual(collect(longer), [{ pos: 1, size: 6, tex: "aaaa" }]);
  assert.deepEqual(collect(repeated), [{ pos: 1, size: 5, tex: "aaa" }]);
});
