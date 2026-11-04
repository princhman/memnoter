import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampZoom, FIT, zoomAround } from '../src/lib/image-zoom.ts';

const bounds = { width: 600, height: 400, imageWidth: 600, imageHeight: 300 };
test('pinch holds the image point under moving fingers and clamps pan to the visible image', () => {
  assert.deepEqual(zoomAround(FIT, { x: 50, y: 20 }, { x: 70, y: 30 }, 2, bounds), { scale: 2, x: -30, y: -10 });
  assert.deepEqual(clampZoom({ scale: 2, x: 10000, y: -10000 }, bounds), { scale: 2, x: 300, y: -100 });
  assert.deepEqual(clampZoom({ scale: 0.5, x: 300, y: 200 }, bounds), FIT);
  const portrait = { width: 600, height: 400, imageWidth: 100, imageHeight: 400 };
  assert.deepEqual(clampZoom({ scale: 2, x: 40, y: 1000 }, portrait), { scale: 2, x: 0, y: 200 });
  assert.equal(zoomAround(FIT, { x: 0, y: 0 }, { x: 0, y: 0 }, 100, bounds).scale, 5);
});
