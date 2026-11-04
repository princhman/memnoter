import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptPixels, detectBackground } from "../src/lib/image-adapt.ts";

// A 4×4 image of `background` with the given pixels inside.
function image(background, inside = {}) {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set(inside[i] ?? background, i * 4);
  return data;
}

const pixel = (data, i) => Array.from(data.slice(i * 4, i * 4 + 4));

test("finds the border colour, or none for transparent borders", () => {
  assert.deepEqual(detectBackground(image([255, 255, 255, 255]), 4, 4), [1, 1, 1]);
  assert.equal(detectBackground(image([0, 0, 0, 0]), 4, 4), null);
});

test("a white background becomes transparent and black ink white in dark mode", () => {
  const data = image([255, 255, 255, 255], { 5: [0, 0, 0, 255], 6: [128, 128, 128, 255] });
  adaptPixels(data, 4, 4, true);
  assert.equal(pixel(data, 0)[3], 0);
  assert.deepEqual(pixel(data, 5), [255, 255, 255, 255]);
  // Mid grey over white is half-transparent black, flipped to white.
  assert.deepEqual(pixel(data, 6).slice(0, 3), [255, 255, 255]);
  assert.ok(Math.abs(pixel(data, 6)[3] - 127) < 2);
});

test("light mode keeps dark ink and only drops the background", () => {
  const data = image([250, 250, 250, 255], { 5: [0, 0, 0, 255] });
  adaptPixels(data, 4, 4, false);
  assert.equal(pixel(data, 0)[3], 0);
  assert.deepEqual(pixel(data, 5), [0, 0, 0, 255]);
});

test("flipping lightness keeps the hue", () => {
  const data = image([255, 255, 255, 255], { 5: [0, 0, 128, 255] });
  adaptPixels(data, 4, 4, true);
  const [r, g, b, a] = pixel(data, 5);
  assert.equal(a, 255);
  assert.ok(b > r && r === g && r > 100, `${r} ${g} ${b}`);
});

test("the background is the border colour covering most of the image", () => {
  // 8×8 white image whose bottom two rows and left column are a grey strip:
  // grey covers more of the border, white covers more of the image.
  const width = 8, height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grey = y >= 6 || x === 0;
      data.set(grey ? [235, 235, 235, 255] : [255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  data.set([0, 0, 0, 255], (3 * width + 4) * 4);
  assert.deepEqual(detectBackground(data, width, height), [1, 1, 1]);
  adaptPixels(data, width, height, true);
  // The white drops out and the grey strip all but disappears; the ink
  // remains, flipped to white.
  assert.equal(pixel(data, 3 * width + 2)[3], 0);
  assert.ok(pixel(data, 7 * width + 7)[3] < 16);
  assert.deepEqual(pixel(data, 3 * width + 4), [255, 255, 255, 255]);
});
