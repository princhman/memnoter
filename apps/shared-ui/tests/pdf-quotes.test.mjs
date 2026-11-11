import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePdfRegion, parsePdfSource } from '../src/lib/pdf-quote.ts';

// Protect the zoom/scroll-independent source contract, including reversed and off-page drags.
test('quote regions clamp to one page and reject tiny drags', () => {
  assert.deepEqual(normalizePdfRegion({ x: 180, y: 90 }, { x: -20, y: 20 }, { width: 200, height: 100 }), { x: 0, y: .2, width: .9, height: .7 });
  assert.deepEqual(normalizePdfRegion({ x: 360, y: 180 }, { x: -40, y: 40 }, { width: 400, height: 200 }), { x: 0, y: .2, width: .9, height: .7 });
  assert.equal(normalizePdfRegion({ x: 1, y: 1 }, { x: 3, y: 60 }, { width: 200, height: 100 }), null);
  const edgeRegion = normalizePdfRegion({ x: 22.4292192466947, y: 0 }, { x: 200, y: 100 }, { width: 200, height: 100 });
  assert.ok(parsePdfSource({ documentId: 'doc', page: 1, name: 'PDF', region: edgeRegion }));
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizePdfRegion({ x: invalid, y: 0 }, { x: 20, y: 20 }, { width: 100, height: 100 }), null);
    assert.equal(normalizePdfRegion({ x: 0, y: 0 }, { x: 20, y: 20 }, { width: invalid, height: 100 }), null);
  }
  for (const documentId of ['', ' ', 'doc\u0000']) {
    assert.equal(parsePdfSource({ documentId, page: 1, name: 'PDF', region: { x: 0, y: 0, width: 1, height: 1 } }), null);
  }
  for (const value of [null, {}, { documentId: 'doc', name: 'Lecture', page: 1, region: { x: .8, y: 0, width: .5, height: 1 } }]) assert.equal(parsePdfSource(value), null);
});
