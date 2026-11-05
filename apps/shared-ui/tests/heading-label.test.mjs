import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingMathLabel } from '../src/lib/heading-label.ts';

test('native heading math stays readable and preserves unsupported TeX', () => {
  for (const [input, expected] of [
    ['E = mc^2', 'E = mc²'],
    ['\\alpha_i \\leq \\frac{1}{2}', 'αᵢ ≤ (1)/(2)'],
    ['\\sqrt{x} + \\pi', '√(x) + π'],
    ['\\begin{matrix}a&b\\end{matrix}', '\\begin{matrix}a&b\\end{matrix}'],
  ]) assert.equal(headingMathLabel(input), expected);
});
