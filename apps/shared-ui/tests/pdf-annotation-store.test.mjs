import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import * as Y from 'yjs';
const events = new EventTarget();
globalThis.window = { setTimeout, clearTimeout, addEventListener: events.addEventListener.bind(events) };
const { openPdfAnnotations, refreshPdfAnnotations, resetPdfAnnotationSessions, pdfAnnotationSaveStatusStore } = await import('../src/lib/pdf-annotation-store.ts');
const { exclusiveWrite, flushAll, isWriteAdmitted } = await import('../src/lib/write-lifecycle.ts');
const { createPdfAnnotation, readPdfAnnotations } = await import('../src/lib/pdf-annotations.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const input = body => ({ kind: 'comment', body, anchors: [{ page: 1, regions: [{ x: 0, y: 0, width: 0.5, height: 0.1 }] }] });
function disk() {
  const documents = new Map();
  let generation = 'one', beforeSave = async () => {}, loads = 0, saves = 0;
  const receipt = id => ({ state: documents.has(id) ? Array.from(Y.encodeStateAsUpdate(documents.get(id))) : null, revision: saves, generation });
  mockIPC(async (command, args) => {
    assert.equal(command, 'core');
    const { command: name, args: request } = args;
    if (name === 'load_annotations') { loads++; return receipt(request.documentId); }
    assert.equal(name, 'save_annotation_update', 'must never mutate notes/cards/indexes');
    saves++; await beforeSave();
    if (request.generation !== generation) throw new Error('stale annotation generation');
    if (!documents.has(request.documentId)) documents.set(request.documentId, new Y.Doc());
    Y.applyUpdate(documents.get(request.documentId), new Uint8Array(request.bytes));
    return receipt(request.documentId);
  });
  return { documents, get loads() { return loads; }, get saves() { return saves; },
    set beforeSave(fn) { beforeSave = fn; }, set generation(value) { generation = value; },
    dispose() { resetPdfAnnotationSessions(); documents.forEach(doc => doc.destroy()); clearMocks(); } };
}
async function reader(id) {
  const owner = openPdfAnnotations(id), close = owner.subscribe(() => {});
  await tick(); assert.equal(owner.getSnapshot().ready, true);
  return { owner, close };
}
test('empty load is SELECT-only; saved readers rehydrate independently and edits/deletes persist', async () => {
  const db = disk(); let a, b;
  try {
    a = await reader('a'); b = await reader('b');
    assert.equal(db.loads, 2); assert.equal(db.saves, 0); assert.equal(db.documents.size, 0);
    const id = a.owner.create(input('first')); await flushAll();
    assert.deepEqual(b.owner.getSnapshot().annotations, []);
    assert.equal(a.owner.updateComment({ id, body: 'edited' }), true);
    await flushAll(); a.close(); a = await reader('a');
    assert.equal(a.owner.getSnapshot().annotations[0].body, 'edited');
    a.owner.remove(id); await flushAll();
    assert.deepEqual(readPdfAnnotations(db.documents.get('a')), []);
    assert.ok(Y.encodeStateAsUpdate(db.documents.get('a')).length > 2);
  } finally { a?.close(); b?.close(); db.dispose(); }
});
test('delayed receipts and remote refresh retain newer edits across reader close/reopen without requeueing', async () => {
  const db = disk(), held = deferred(); let a;
  try {
    a = await reader('merge'); db.beforeSave = () => held.promise;
    a.owner.create(input('local first')); a.owner.create(input('local newer'));
    assert.equal(a.owner.getSnapshot().saving, true);
    a.close(); a = await reader('merge');
    assert.equal(a.owner.getSnapshot().annotations.length, 2);
    const remote = new Y.Doc(); createPdfAnnotation(remote, input('remote')); db.documents.set('merge', remote);
    refreshPdfAnnotations(['merge']); await tick();
    assert.equal(a.owner.getSnapshot().annotations.length, 3); assert.equal(db.saves, 1);
    held.resolve(); await flushAll();
    assert.equal(db.saves, 2);
    assert.deepEqual(a.owner.getSnapshot().annotations.map(x => x.body).sort(), ['local first', 'local newer', 'remote']);
    assert.equal(readPdfAnnotations(db.documents.get('merge')).length, 3);
    assert.equal(a.owner.getSnapshot().saving, false);
  } finally { held.resolve(); a?.close(); db.dispose(); }
});
test('ordinary errors retain dirty edits for retry; exclusive delete drains then reloads sessions', async () => {
  const db = disk(); let a;
  try {
    a = await reader('retry'); let fail = true;
    db.beforeSave = async () => { if (fail) throw new Error('disk full'); };
    a.owner.create(input('unsaved')); await tick();
    assert.match(a.owner.getSnapshot().error, /disk full/);
    await assert.rejects(exclusiveWrite(async () => { throw new Error('must not run'); }, { kind: 'delete' }), /PDF annotations/);
    assert.equal(isWriteAdmitted(), true); assert.equal(a.owner.getSnapshot().annotations.length, 1);
    fail = false; a.owner.retry(); await flushAll(); assert.equal(a.owner.getSnapshot().error, null);
    const held = deferred(); db.beforeSave = () => held.promise;
    a.owner.create(input('second')); let deleted = false;
    const deleting = exclusiveWrite(async () => { deleted = true; db.documents.get('retry').destroy(); db.documents.delete('retry'); }, { kind: 'delete' });
    await tick(); assert.equal(deleted, false); held.resolve(); await deleting; await tick();
    assert.deepEqual(a.owner.getSnapshot().annotations, []);
  } finally { a?.close(); db.dispose(); }
});
test('stale generation retires old bytes; retry reloads without replaying them', async () => {
  const db = disk(); let a;
  try {
    a = await reader('stale'); db.generation = 'two'; a.owner.create(input('old')); await tick(); await tick();
    assert.equal(a.owner.getSnapshot().ready, false); assert.match(a.owner.getSnapshot().error, /database changed/);
    assert.throws(() => a.owner.create(input('blocked')), /not ready/);
    assert.equal(pdfAnnotationSaveStatusStore.state.pending, 0); const attempts = db.saves;
    a.owner.retry(); await tick(); assert.equal(a.owner.getSnapshot().ready, true);
    assert.deepEqual(a.owner.getSnapshot().annotations, []); assert.equal(db.saves, attempts);
    a.owner.create(input('fresh')); await flushAll();
    assert.deepEqual(readPdfAnnotations(db.documents.get('stale')).map(x => x.body), ['fresh']);
  } finally { a?.close(); db.dispose(); }
});
for (const kind of ['exit', 'restore']) test(`${kind} drains receipts before native action`, async () => {
  const db = disk(), held = deferred(), cancelled = new Error('host cancelled'); let a;
  try {
    a = await reader(kind); db.beforeSave = () => held.promise; a.owner.create(input('drain')); let action = false;
    const operation = exclusiveWrite(async () => {
      action = true; assert.equal(readPdfAnnotations(db.documents.get(kind)).length, 1); throw cancelled;
    }, { kind });
    const rejected = assert.rejects(operation, error => error === cancelled);
    await tick(); assert.equal(action, false); assert.throws(() => a.owner.create(input('late')), /suspended/);
    held.resolve(); await rejected; assert.equal(action, true); assert.equal(isWriteAdmitted(), true);
  } finally { held.resolve(); a?.close(); db.dispose(); }
});

test('cancelled discard exit waits for active writes and retains queued edits for continued editing', async () => {
  const db = disk(), held = deferred(); let a;
  const cancelled = new Error('cancel exit');
  try {
    a = await reader('discard'); db.beforeSave = () => held.promise;
    a.owner.create(input('in flight')); a.owner.create(input('queued'));
    let action = false;
    const exiting = exclusiveWrite(async () => { action = true; throw cancelled; }, { kind: 'exit', unsaved: 'discard' });
    const rejected = assert.rejects(exiting, error => error === cancelled);
    await tick(); assert.equal(action, false);
    held.resolve(); await rejected;
    assert.equal(a.owner.getSnapshot().annotations.length, 2);
    await flushAll(); assert.equal(db.saves, 2);
  } finally { held.resolve(); a?.close(); db.dispose(); }
});

test('committed restore clears old session state and blocks mutations until host reload', async () => {
  const db = disk(); let a;
  try {
    a = await reader('restore-success'); a.owner.create(input('before restore')); await flushAll();
    await exclusiveWrite(async () => {
      db.documents.get('restore-success').destroy(); db.documents.clear(); db.generation = 'restored';
    }, { kind: 'restore' });
    assert.equal(a.owner.getSnapshot().ready, false);
    assert.deepEqual(a.owner.getSnapshot().annotations, []);
    assert.equal(pdfAnnotationSaveStatusStore.state.pending, 0);
    assert.equal(isWriteAdmitted(), false);
    assert.throws(() => a.owner.create(input('obsolete')), /suspended/);
  } finally { a?.close(); db.dispose(); }
});
