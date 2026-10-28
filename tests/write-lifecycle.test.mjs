import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { invoke } from '@tauri-apps/api/core';
import * as Y from 'yjs';
const src = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) specifier = ${JSON.stringify(src)} + specifier.slice(2) + '.ts';
    return next(specifier, context);
  }
`)}`, import.meta.url);
globalThis.window = { setTimeout, clearTimeout };
const { exclusiveWrite, imageOperation, imageFilesOperation, imageStatusStore, discardFailedImages, watchWriteAdmission } = await import('../src/lib/write-lifecycle.ts');
const { saveQueue } = await import('../src/lib/saves.ts');
const { queryClient } = await import('../src/lib/query-client.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('source deletion retries foreign Yjs references before scanning and preserves failed edits', async () => {
  const doc = new Y.Doc();
  const disk = new Y.Doc();
  let fail = true;
  let scans = 0;
  let blocked = false;
  const stop = watchWriteAdmission(value => { blocked = value; });
  mockIPC((command, args) => {
    if (command === 'delete_module') {
      scans++;
      assert.equal(blocked, true);
      assert.equal(disk.getMap('image').get('fileId'), 'owned-by-A');
      return;
    }
    assert.equal(command, 'add_update');
    if (fail) throw new Error('disk full');
    Y.applyUpdate(disk, new Uint8Array(args.bytes));
    return { id: 1, bytes: args.bytes };
  });
  const removeSource = () => queryClient.getMutationCache().build(queryClient, {
    gcTime: 0,
    mutationKey: ['delete-module'],
    mutationFn: () => exclusiveWrite(() => invoke('delete_module', { moduleId: 'A' }), {
      excludedMutation: 'delete-module',
    }),
  }).execute();
  try {
    doc.on('update', bytes => saveQueue.enqueue('B', Array.from(bytes)));
    doc.getMap('image').set('fileId', 'owned-by-A');
    await tick();
    await assert.rejects(removeSource(), /Pending edits/);
    assert.equal(scans, 0, 'failed save must prevent native shared-reference scan');
    assert.equal(saveQueue.pending('B').length, 1);
    assert.equal(blocked, false, 'failure reopens admission without discarding B');
    fail = false;
    await removeSource();
    assert.equal(scans, 1);
    assert.equal(saveQueue.isEmpty(), true);
  } finally { stop(); saveQueue.clear(); queryClient.clear(); clearMocks(); doc.destroy(); disk.destroy(); }
});

test('quit waits beyond QueryClient upload completion for insertion and its ensuing Yjs receipt', async () => {
  const uploaded = deferred();
  const continuation = deferred();
  const persisted = deferred();
  const doc = new Y.Doc();
  const disk = new Y.Doc();
  let saving = false;
  let exited = false;
  mockIPC(async (command, args) => {
    assert.equal(command, 'add_update');
    saving = true;
    await persisted.promise;
    Y.applyUpdate(disk, new Uint8Array(args.bytes));
    return { id: 2, bytes: args.bytes };
  });
  try {
    doc.on('update', bytes => saveQueue.enqueue('B', Array.from(bytes)));
    const insertion = imageOperation(async () => {
      const mutation = queryClient.getMutationCache().build(queryClient, {
        gcTime: 0, mutationKey: ['upload-file'], mutationFn: () => uploaded.promise,
      });
      await mutation.execute();
      await continuation.promise;
      assert.equal(saveQueue.isSuspended(), false, 'admitted insertion is still allowed to enqueue');
      doc.getMap('image').set('fileId', 'uploaded');
    });
    await tick();
    const quit = exclusiveWrite(async () => {
      assert.equal(disk.getMap('image').get('fileId'), 'uploaded');
      exited = true;
    });
    await assert.rejects(imageOperation(async () => {}), /suspended/);
    await assert.rejects(exclusiveWrite(async () => {}), /in progress/);
    uploaded.resolve('uploaded');
    await tick();
    assert.equal(queryClient.isMutating(), 0);
    assert.equal(exited, false, 'mutation completion precedes insertion continuation');
    continuation.resolve();
    await insertion;
    await tick();
    assert.equal(saving, true);
    assert.equal(exited, false, 'Yjs save acknowledgement is still outstanding');
    persisted.resolve();
    await quit;
    assert.equal(exited, true);
  } finally {
    uploaded.resolve(); continuation.resolve(); persisted.resolve();
    saveQueue.clear(); queryClient.clear(); clearMocks(); doc.destroy(); disk.destroy();
  }
});

test('failed image continuation blocks normal exit; explicit discard still waits for native operations', async () => {
  const upload = deferred();
  const native = deferred();
  let exited = false;
  const insertion = imageOperation(async () => { await upload.promise; throw new Error('upload failed'); });
  const rejection = assert.rejects(insertion, /upload failed/);
  const normal = exclusiveWrite(async () => { exited = true; });
  upload.resolve();
  await rejection;
  await assert.rejects(normal, /image could not be saved/);
  assert.equal(exited, false);
  const mutation = queryClient.getMutationCache().build(queryClient, {
    gcTime: 0, mutationKey: ['card-write'], mutationFn: () => native.promise,
  }).execute();
  const discard = exclusiveWrite(async () => { exited = true; }, { discard: true });
  await tick();
  assert.equal(exited, false);
  await assert.rejects(exclusiveWrite(async () => {}), /in progress/);
  native.resolve();
  await mutation;
  await discard;
  assert.equal(exited, true);
  assert.equal(saveQueue.isSuspended(), false);
  queryClient.clear();
});


test('completed failure remains visible across quit, failed retry and unrelated success; resumable files save before exit', async () => {
  const doc = new Y.Doc();
  const disk = new Y.Doc();
  const persisted = deferred();
  const uploads = [];
  let fail = true;
  let exited = false;
  let blocked = false;
  const stop = watchWriteAdmission(value => { blocked = value; });
  mockIPC(async (command, args) => {
    if (command === 'upload') {
      uploads.push(args.file);
      if (args.file === 'second' && fail) throw new Error('offline');
      return args.file;
    }
    assert.equal(command, 'add_update');
    await persisted.promise;
    Y.applyUpdate(disk, new Uint8Array(args.bytes));
    return { id: 3, bytes: args.bytes };
  });
  const quit = () => exclusiveWrite(async () => {
    assert.deepEqual(disk.getArray('images').toArray(), ['first', 'second']);
    exited = true;
  }, { retryImages: true });
  try {
    doc.on('update', bytes => saveQueue.enqueue('retry-note', Array.from(bytes)));
    await assert.rejects(imageFilesOperation(['first', 'second'], {
      checkTarget: () => assert.equal(saveQueue.isSuspended(), false),
      upload: file => queryClient.getMutationCache().build(queryClient, {
        gcTime: 0, mutationKey: ['upload-file'], mutationFn: () => invoke('upload', { file }),
      }).execute(),
      insert: saved => doc.getArray('images').push([saved]),
      dispose: () => {},
    }), /offline/);
    assert.match(imageStatusStore.state.errors.join(), /offline/);
    await imageOperation(async () => {});
    await assert.rejects(exclusiveWrite(async () => { exited = true; }), /offline/);
    await assert.rejects(quit(), /offline/);
    assert.equal(exited, false);
    assert.deepEqual(doc.getArray('images').toArray(), ['first']);
    fail = false;
    const retry = quit();
    await tick();
    assert.equal(blocked, true);
    assert.equal(exited, false, 'receipt still outstanding');
    await assert.rejects(imageOperation(async () => {}), /suspended/);
    await assert.rejects(quit(), /in progress/);
    persisted.resolve();
    await retry;
    assert.equal(exited, true);
    assert.deepEqual(uploads, ['first', 'second', 'second', 'second']);
    assert.equal(imageStatusStore.state.errors.length, 0);
  } finally {
    persisted.resolve(); stop(); saveQueue.clear(); queryClient.clear(); clearMocks(); doc.destroy(); disk.destroy(); discardFailedImages();
  }
});

test('unsafe or destroyed targets remain blocked until explicit discard without replaying stale work', async () => {
  let alive = true;
  let inserts = 0;
  let attempts = 0;
  await assert.rejects(imageFilesOperation(['file'], {
    checkTarget: () => { if (!alive) throw new Error('original note closed'); },
    upload: async () => { attempts++; alive = false; return 'receipt'; },
    insert: () => { inserts++; }, dispose: () => {},
  }), /closed/);
  await assert.rejects(imageOperation(async () => { throw new Error('crop target changed'); }), /crop/);
  await assert.rejects(exclusiveWrite(async () => {}, { retryImages: true }), /closed/);
  assert.equal(attempts, 1);
  assert.equal(inserts, 0);
  assert.equal(imageStatusStore.state.errors.length, 2);
  discardFailedImages();
  await exclusiveWrite(async () => {});
  assert.equal(imageStatusStore.state.errors.length, 0);
});
