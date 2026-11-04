import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { LATEX_ENTRIES, LOOKALIKES, searchLatex } from "../src/lib/latex-symbols.ts";

test("every lookalike refers to a catalog entry", () => {
  const labels = new Set(LATEX_ENTRIES.map((entry) => entry.label));
  for (const [label] of LOOKALIKES.flat()) assert.ok(labels.has(label), label);
  const vert = LATEX_ENTRIES.find((entry) => entry.label === "\\vert");
  assert.ok(vert.note);
  assert.ok(vert.similar.some((entry) => entry.label === "\\mid"));
});

// Templates whose empty argument is a size or color are only valid once filled.
const NEEDS_ARGUMENT = new Set(["\\hspace{}", "\\color{}{}", "\\textcolor{}{}"]);

test("every entry's insert and preview are valid KaTeX", () => {
  for (const entry of LATEX_ENTRIES) {
    const sources = NEEDS_ARGUMENT.has(entry.insert)
      ? [entry.preview]
      : [entry.insert, entry.preview];
    for (const tex of sources) {
      assert.doesNotThrow(
        () => katex.renderToString(tex, { throwOnError: true }),
        `${entry.label}: ${tex}`,
      );
    }
  }
});

test("labels are unique and the caret lands inside the insert", () => {
  const labels = new Set();
  for (const entry of LATEX_ENTRIES) {
    assert.ok(!labels.has(entry.label), `duplicate ${entry.label}`);
    labels.add(entry.label);
    assert.ok(entry.caret >= 0 && entry.caret <= entry.insert.length, entry.label);
  }
  const frac = LATEX_ENTRIES.find((entry) => entry.label === "\\frac{}{}");
  assert.equal(frac.insert.slice(0, frac.caret), "\\frac{");
  const pmatrix = LATEX_ENTRIES.find((entry) => entry.label === "\\begin{pmatrix}");
  assert.equal(pmatrix.insert.slice(0, pmatrix.caret), "\\begin{pmatrix} ");
});

test("ranking prefers exact names, then case, prefixes, keywords, fuzzy", () => {
  const labels = (query, options) => searchLatex(query, options).map((entry) => entry.label);

  assert.equal(labels("in")[0], "\\in");
  assert.ok(labels("in").includes("\\infty"));
  assert.equal(labels("Del")[0], "\\Delta");
  assert.equal(labels("del")[0], "\\delta");
  assert.ok(labels("arrow").includes("\\Rightarrow"));
  assert.ok(labels("pmat").includes("\\begin{pmatrix}"));
  assert.ok(labels("lra").includes("\\leftrightarrow"));
  assert.deepEqual(labels(""), []);
});

test("usage lifts entries within a tier, strict drops keyword matches", () => {
  const top = searchLatex("var", { usage: { "\\varphi": 5 } })[0];
  assert.equal(top.label, "\\varphi");

  assert.deepEqual(searchLatex("Users", { strict: true }), []);
  assert.ok(searchLatex("arrow", { strict: true }).every((entry) => entry.name.toLowerCase().startsWith("arrow")));
});
