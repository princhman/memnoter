import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { groupMathScripts } from "../src/lib/latex-render.ts";

const cases = [
  ["a^qbc", "a^{qbc}"],
  ["a_qbc", "a_{qbc}"],
  ["a_{x}", "a_{x}"],
  [String.raw`a_\frac{1}{2}`, String.raw`a_{\frac{1}{2}}`],
  ["x^2+y^2", "x^2+y^2"],
  ["x^10", "x^{10}"],
  ["x^2.5", "x^2.5"],
  ["a^n-1", "a^n-1"],
  ["a^ij=k", "a^{ij}=k"],
  ["e^{i\\pi}+1", "e^{i\\pi}+1"],
  ["f(x)^ab, y", "f(x)^{ab}, y"],
  [String.raw`a^b\,c`, String.raw`a^b\,c`],
  ["a^{x}", "a^{x}"],
  ["x^2", "x^2"],
  [String.raw`a^\alpha b`, String.raw`a^{\alpha} b`],
  [String.raw`a^\frac{1}{2}`, String.raw`a^{\frac{1}{2}}`],
  [String.raw`a^\frac{x^ab}{2} z`, String.raw`a^{\frac{x^{ab}}{2}} z`],
  [String.raw`a^\sqrt[3]{x}`, String.raw`a^{\sqrt[3]{x}}`],
  ["a^ab_cd", "a^{ab}_{cd}"],
  ["{a^bc}", "{a^{bc}}"],
  ["a^bc$d", "a^{bc}$d"],
  ["a^bc&d", "a^{bc}&d"],
  [String.raw`a^bc\\d`, String.raw`a^{bc}\\d`],
  ["a^bc\nd", "a^{bc}\nd"],
  ["a^ bc", "a^ bc"],
  [String.raw`\text{a^bc _de {nested} \} end} x^ab`, String.raw`\text{a^bc _de {nested} \} end} x^{ab}`],
  [String.raw`a^\text{a^bc _de}`, String.raw`a^{\text{a^bc _de}}`],
  [String.raw`a\^bc \_de`, String.raw`a\^bc \_de`],
  [String.raw`a^b\}c\$d\&e\_f\^g`, String.raw`a^{b\}c\$d\&e\_f\^g}`],
  ["a^", "a^"],
  [String.raw`a^\frac{1`, String.raw`a^\frac{1`],
];

for (const [source, expected] of cases) {
  test(`script grouping: ${JSON.stringify(source)}`, () => {
    assert.equal(groupMathScripts(source), expected);
    assert.equal(groupMathScripts(expected), expected, "preprocessing is idempotent");
  });
}

test("KaTeX renders shorthand with the same math layout as explicit groups", () => {
  for (const source of ["a^qbc", "a_qbc", String.raw`a^\alpha b`, String.raw`a^\frac{1}{2}`, "x^2"]) {
    const expanded = groupMathScripts(source);
    const options = { throwOnError: true, output: "html" };
    assert.equal(katex.renderToString(expanded, options), katex.renderToString(cases.find(([input]) => input === source)[1], options));
  }
});
