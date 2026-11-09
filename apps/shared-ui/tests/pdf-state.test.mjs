import test from 'node:test';
import assert from 'node:assert/strict';
import { documentName, parsePage, parsePdfView, parsePdfPane, visiblePages } from '../src/lib/pdf-state.ts';
test('PDF names drop only their final PDF extension', () => {
  assert.equal(documentName('Lecture.PDF'), 'Lecture');
  assert.equal(documentName('a.pdf.notes.pdf'), 'a.pdf.notes');
  assert.equal(documentName('notes'), 'notes');
});
test('page entry rejects partial, fractional and out of range values', () => {
  for (const value of ['', '0', '49', '1.2', '2abc', '-1', 'Infinity']) assert.equal(parsePage(value, 48), null);
  assert.equal(parsePage(' 12 ', 48), 12);
  assert.equal(parsePage('48', 48), 48);
});
test('render window includes visible mixed-size pages and one neighbour', () => {
  assert.deepEqual(visiblePages([100, 200, 100, 300, 100], 110, 100), [0, 1, 2]);
  assert.deepEqual(visiblePages([100, 200, 100, 300, 100], 350, 200), [1, 2, 3, 4]);
  assert.deepEqual(visiblePages([], 0, 100), []);
  assert.deepEqual(visiblePages([100, 100, 100], 0, 50), [0, 1]);
});
test('persisted view tolerates corrupt state and clamps zoom', () => {
  assert.deepEqual(parsePdfView(null), { page: 1, zoom: 1 });
  assert.deepEqual(parsePdfView({ page: -1, zoom: Infinity }), { page: 1, zoom: 1 });
  assert.deepEqual(parsePdfView({ page: 12, zoom: 1.5 }), { page: 12, zoom: 1.5 });
  assert.deepEqual(parsePdfView({ page: 3.2, zoom: 10 }), { page: 1, zoom: 3 });
});

test('pane state restores each field independently and bounds its width', () => {
  assert.deepEqual(parsePdfPane(null), { open: false, width: 420, active: null });
  const state = { open: true, width: 480, active: 'lecture-3' };
  assert.deepEqual(parsePdfPane(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(parsePdfPane({ open: 1, width: -20, active: 3 }), { open: false, width: 320, active: null });
  assert.equal(parsePdfPane({ width: Infinity }).width, 420);
});
