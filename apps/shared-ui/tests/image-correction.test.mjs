import assert from "node:assert/strict";
import { test } from "node:test";
import { correctImagePixels } from "../src/lib/image-correction.ts";

test("dim, warm paper gets brighter and more neutral while its writing gains contrast", () => {
  const shade = Array.from({ length: 40 }, (_, i) => [100 + i, 80 + i, 64 + i, 255]);
  const pixels = new Uint8ClampedArray([[47, 31, 22, 255], ...shade, [0, 0, 0, 0]].flat());
  assert.equal(correctImagePixels(pixels), true);
  const [ink, , , inkAlpha] = pixels;
  const [red, green, blue, paperAlpha] = pixels.slice(-8, -4);
  assert.ok(green >= 180, "the paper should get brighter");
  assert.ok(Math.max(red, green, blue) - Math.min(red, green, blue) <= 6, "the paper should lose its warm cast");
  assert.ok(green - ink >= 140, "writing and paper should be easier to distinguish");
  assert.deepEqual([inkAlpha, paperAlpha, ...pixels.slice(-4)], [255, 255, 0, 0, 0, 0]);
});

test("a clean full-range image and a muted flat-colour graphic retain their pixels", () => {
  const clean = Array.from({ length: 256 }, (_, i) => [i, i, i, 255]);
  clean.splice(100, 20, ...Array.from({ length: 20 }, () => [80, 145, 210, 255]));
  const flat = Array.from({ length: 100 }, (_, i) => i < 40 ? [28, 35, 45, 255] : [164, 173, 184, 255]);
  for (const sample of [clean, flat]) {
    const original = new Uint8ClampedArray(sample.flat());
    const pixels = original.slice();
    assert.equal(correctImagePixels(pixels), false);
    assert.deepEqual(pixels, original);
  }
});
