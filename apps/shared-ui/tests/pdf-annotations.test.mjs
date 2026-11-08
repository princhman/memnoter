import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import {
  createPdfAnnotation, readPdfAnnotations, removePdfAnnotation, updatePdfAnnotationComment,
} from '../src/lib/pdf-annotations.ts';

const anchors = [
  { page: 1, regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, { x: 0.1, y: 0.3, width: 0.5, height: 0.04 }] },
  { page: 3, regions: [{ x: 0, y: 0, width: 1, height: 1 }] },
];
const highlight = () => ({ kind: 'highlight', anchors, excerpt: 'Selected\ntext' });
const comment = (body = 'first middle last') => ({ kind: 'comment', anchors, body });
const copy = doc => {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  return replica;
};
function assertDeliveryOrders(updates, expected) {
  for (const ordered of [updates, [...updates].reverse()]) {
    const receiver = new Y.Doc();
    for (const update of ordered) Y.applyUpdate(receiver, update);
    assert.deepEqual(readPdfAnnotations(receiver), expected);
    for (const update of ordered) Y.applyUpdate(receiver, update);
    assert.deepEqual(readPdfAnnotations(receiver), expected, 'replay is idempotent');
    assert.deepEqual(readPdfAnnotations(copy(receiver)), expected, 'encoded state rehydrates');
    receiver.destroy();
  }
}

test('empty and missing-item reads/edits create no Yjs content or updates', () => {
  const doc = new Y.Doc();
  const before = Y.encodeStateAsUpdate(doc);
  let updates = 0;
  doc.on('update', () => updates++);
  assert.deepEqual(readPdfAnnotations(doc), []);
  assert.equal(updatePdfAnnotationComment(doc, { id: 'ab29c115-7762-433e-b266-f836204ac013', body: 'missing' }), false);
  assert.equal(doc.share.size, 0);
  assert.equal(updates, 0);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
});

test('multi-page selection and plain comments survive mutation, serialization, and caller mutation', () => {
  const doc = new Y.Doc();
  const input = structuredClone(highlight());
  const id = createPdfAnnotation(doc, input);
  assert.match(id, /^[0-9a-f-]{36}$/);
  input.anchors[0].regions[0].x = 0.9;
  assert.deepEqual(readPdfAnnotations(doc), [{ ...highlight(), body: '', id, color: 'primary' }]);
  assert.equal(updatePdfAnnotationComment(doc, { id, body: '<b>literal</b>\nNote' }), true);
  const view = readPdfAnnotations(doc);
  view[0].anchors[0].regions[0].x = 0.99;
  assert.equal(readPdfAnnotations(doc)[0].anchors[0].regions[0].x, 0.1);
  assert.deepEqual(readPdfAnnotations(copy(doc)), [{ ...highlight(), body: '<b>literal</b>\nNote', id, color: 'primary' }]);
  assert.equal(updatePdfAnnotationComment(doc, { id, body: '' }), true, 'a highlight can clear its comment');
  const commentId = createPdfAnnotation(doc, comment('  Keep whitespace\n'));
  assert.throws(() => updatePdfAnnotationComment(doc, { id: commentId, body: ' \n\t' }), /nonempty/);
  assert.equal(readPdfAnnotations(doc).find(item => item.id === commentId).body, '  Keep whitespace\n');
});

test('independent concurrent creates and edits merge across two documents in either delivery order', () => {
  const left = new Y.Doc();
  const right = new Y.Doc();
  const leftId = createPdfAnnotation(left, highlight());
  const rightId = createPdfAnnotation(right, comment('right'));
  updatePdfAnnotationComment(left, { id: leftId, body: 'left edited' });
  updatePdfAnnotationComment(right, { id: rightId, body: 'right edited' });
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
  const expected = [
    { ...highlight(), body: 'left edited', id: leftId, color: 'primary' },
    { ...comment('right edited'), id: rightId, color: 'primary' },
  ].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(readPdfAnnotations(left), expected);
  assert.deepEqual(readPdfAnnotations(right), expected);
  assertDeliveryOrders([leftUpdate, rightUpdate], expected);
  // Once both know both IDs, updates to different maps must also survive.
  updatePdfAnnotationComment(left, { id: leftId, body: 'left again' });
  updatePdfAnnotationComment(right, { id: rightId, body: 'right again' });
  assertDeliveryOrders([Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)], expected.map(item => ({
    ...item, body: item.id === leftId ? 'left again' : 'right again',
  })));
});

test('concurrent disjoint edits within one comment preserve both edits', () => {
  const left = new Y.Doc();
  const id = createPdfAnnotation(left, comment());
  const right = copy(left);
  updatePdfAnnotationComment(left, { id, body: 'FIRST middle last' });
  updatePdfAnnotationComment(right, { id, body: 'first middle LAST' });
  assertDeliveryOrders([Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)], [
    { ...comment('FIRST middle LAST'), id, color: 'primary' },
  ]);
});

test('comment replacement preserves complete Unicode characters at splice boundaries', () => {
  const doc = new Y.Doc();
  const id = createPdfAnnotation(doc, comment('A😀Z'));
  for (const body of ['A😁Z', 'A🨁Z', 'A🨁!Z', 'A😀Z']) {
    updatePdfAnnotationComment(doc, { id, body });
    assert.equal(readPdfAnnotations(doc)[0].body, body);
    assert.equal(readPdfAnnotations(copy(doc))[0].body, body);
  }
});

test('overlapping concurrent replacements converge under Y.Text rather than dropping either insertion', () => {
  const left = new Y.Doc();
  const id = createPdfAnnotation(left, comment('old'));
  const right = copy(left);
  updatePdfAnnotationComment(left, { id, body: 'AAA' });
  updatePdfAnnotationComment(right, { id, body: 'BBB' });
  const updates = [Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)];
  Y.applyUpdate(left, updates[1]);
  Y.applyUpdate(right, updates[0]);
  const result = readPdfAnnotations(left);
  assert.deepEqual(readPdfAnnotations(right), result);
  assert.ok(['AAABBB', 'BBBAAA'].includes(result[0].body));
  assertDeliveryOrders(updates, result);
});

test('concurrent removals can empty a comment without hiding its anchor or preventing further editing', () => {
  const left = new Y.Doc();
  const id = createPdfAnnotation(left, comment('ab'));
  const right = copy(left);
  updatePdfAnnotationComment(left, { id, body: 'a' });
  updatePdfAnnotationComment(right, { id, body: 'b' });
  const updates = [Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)];
  assertDeliveryOrders(updates, [{ ...comment(''), id, color: 'primary' }]);
  Y.applyUpdate(left, updates[1]);
  assert.equal(updatePdfAnnotationComment(left, { id, body: 'revised' }), true);
  assert.equal(readPdfAnnotations(left)[0].body, 'revised');
});

test('deletion wins over concurrent and delayed edits, even before the create arrives', () => {
  const left = new Y.Doc();
  const id = createPdfAnnotation(left, comment());
  const right = copy(left);
  removePdfAnnotation(left, id);
  updatePdfAnnotationComment(right, { id, body: 'late edit' });
  assertDeliveryOrders([Y.encodeStateAsUpdate(left), Y.encodeStateAsUpdate(right)], []);
  assert.equal(updatePdfAnnotationComment(left, { id, body: 'resurrect' }), false);
  const unknown = new Y.Doc();
  removePdfAnnotation(unknown, id);
  assertDeliveryOrders([Y.encodeStateAsUpdate(unknown), Y.encodeStateAsUpdate(right)], []);
  let updates = 0;
  left.on('update', () => updates++);
  removePdfAnnotation(left, id);
  assert.equal(updates, 0, 'repeated removal is a no-op');
});

test('invalid external selections, IDs, and text fail before producing document updates', () => {
  const doc = new Y.Doc();
  const badInputs = [
    null, {}, { ...comment(), body: '' }, { ...comment(), body: ' \n' },
    { ...highlight(), kind: 'thread' }, { ...highlight(), body: 42 },
    { ...highlight(), excerpt: 'bad\0text' }, { ...comment(), body: 'bad\x01text' },
    { ...comment(), body: '\ud800' }, { ...highlight(), excerpt: '\udc00' },
    { ...highlight(), anchors: [] }, { ...highlight(), anchors: [{ page: 0, regions: anchors[0].regions }] },
    { ...highlight(), anchors: [{ page: 1.5, regions: anchors[0].regions }] },
    { ...highlight(), anchors: [{ page: Infinity, regions: anchors[0].regions }] },
    { ...highlight(), anchors: [anchors[1], anchors[0]] },
    { ...highlight(), anchors: [anchors[0], anchors[0]] },
    { ...highlight(), anchors: [{ page: 1, regions: [] }] },
    ...[
      { x: NaN }, { y: Infinity }, { x: -0.1 }, { width: 0 }, { height: -1 },
      { x: 0.9, width: 0.2 }, { y: 0.99, height: 0.1 }, { x: '0.1' },
    ].map(region => ({ ...highlight(), anchors: [{ page: 1, regions: [{ ...anchors[0].regions[0], ...region }] }] })),
  ];
  for (const input of badInputs) assert.throws(() => createPdfAnnotation(doc, input), TypeError);
  for (const id of ['', 'no-id', 4, 'AB29C115-7762-433E-B266-F836204AC013']) {
    assert.throws(() => removePdfAnnotation(doc, id), TypeError);
    assert.throws(() => updatePdfAnnotationComment(doc, { id, body: 'body' }), TypeError);
  }
  assert.throws(() => updatePdfAnnotationComment(doc, { id: 'ab29c115-7762-433e-b266-f836204ac013', body: '\0' }), TypeError);
  assert.equal(doc.share.size, 0);
});

test('malformed remote entries are skipped without hiding valid annotations', () => {
  const doc = new Y.Doc();
  const validId = createPdfAnnotation(doc, comment('valid'));
  const root = doc.getMap('pdfAnnotations');
  const malformed = [
    'json instead of map', new Y.Map(),
    new Y.Map([['kind', 'comment'], ['anchors', anchors], ['body', 'not Y.Text']]),
    new Y.Map([['kind', 'comment'], ['anchors', anchors], ['body', new Y.Text('\0')]]),
    new Y.Map([['kind', 'unknown'], ['anchors', anchors], ['body', new Y.Text('text')]]),
    new Y.Map([['kind', 'highlight'], ['anchors', [{ page: -1, regions: [] }]], ['body', new Y.Text()]]),
  ];
  const embedded = new Y.Text();
  embedded.insertEmbed(0, { image: 'not plain text' });
  malformed.push(new Y.Map([['kind', 'comment'], ['anchors', anchors], ['body', embedded]]));
  for (const value of malformed) root.set(crypto.randomUUID(), value);
  root.set('invalid-id', new Y.Map([['kind', 'highlight'], ['anchors', anchors], ['body', new Y.Text()]]));
  const expected = [{ ...comment('valid'), id: validId, color: 'primary' }];
  assert.deepEqual(readPdfAnnotations(copy(doc)), expected);
  const wrongRoot = new Y.Doc();
  wrongRoot.getArray('pdfAnnotations').push(['bad']);
  assert.deepEqual(readPdfAnnotations(wrongRoot), []);
});
