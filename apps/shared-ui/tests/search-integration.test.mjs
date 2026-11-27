import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import * as Y from 'yjs';

globalThis.window = { setTimeout, clearTimeout, addEventListener() {} };
globalThis.localStorage = { getItem: () => null };
const { indexStoredNote, flushSearchIndexing } = await import('../src/lib/search-index.ts');
const { acknowledgeContent, acknowledgeCompaction } = await import('../src/lib/content.ts');
const { flushAll } = await import('../src/lib/write-lifecycle.ts');
const { saveQueue } = await import('../src/lib/saves.ts');
const { queryClient } = await import('../src/lib/query-client.ts');

test('stored search indexing reconciles late reads and joins the restore mutation drain', async () => {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Acknowledged searchable text');
  paragraph.insert(0, [text]);
  doc.getXmlFragment('default').insert(0, [paragraph]);
  const update = { id: 1, bytes: Array.from(Y.encodeStateAsUpdate(doc)) };
  let finishRead;
  let finishIndex;
  const writes = [];
  mockIPC((command, args) => {
    if (command === "core") { command = args.command; args = args.args; }
    if (command === 'get_content') return new Promise(resolve => { finishRead = resolve; });
    assert.equal(command, 'index_note');
    writes.push(args);
    return new Promise(resolve => { finishIndex = resolve; });
  });
  try {
    const indexing = indexStoredNote('search-receipt');
    acknowledgeContent('search-receipt', update);
    finishRead({ state: [], updates: [], files: [] });
    // Let real QueryClient mutation admission and IPC proceed.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes[0].body, 'Acknowledged searchable text');
    assert.equal(writes[0].backfill, true);
    assert.equal(queryClient.isMutating(), 1, 'restore must wait for this write');
    finishIndex();
    await indexing;
    assert.equal(queryClient.isMutating(), 0);

    acknowledgeCompaction('search-receipt', update.bytes, [update]);
    const afterCompaction = indexStoredNote('search-receipt');
    finishRead({ state: [], updates: [], files: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes[1].body, 'Acknowledged searchable text');
    finishIndex();
    await afterCompaction;

    const delayed = assert.rejects(indexStoredNote('search-receipt'), /suspended/);
    await saveQueue.suspend();
    finishRead({ state: [], updates: [], files: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2, 'a late read cannot admit a write during restore');
    await delayed;
  } finally {
    finishIndex?.();
    saveQueue.resume();
    for (const mutation of queryClient.getMutationCache().getAll()) mutation.destroy();
    queryClient.clear();
    clearMocks();
    doc.destroy();
  }
});

test('failed stored indexing reports failure and a later request writes the stored text', async () => {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Text that failed to index');
  paragraph.insert(0, [text]);
  doc.getXmlFragment('default').insert(0, [paragraph]);
  const content = { state: [], updates: [{ id: 1, bytes: Array.from(Y.encodeStateAsUpdate(doc)) }], files: [] };
  const writes = [];
  let failing = true;
  mockIPC((command, args) => {
    if (command === "core") { command = args.command; args = args.args; }
    if (command === 'get_content') return content;
    writes.push(args);
    if (failing) throw new Error('database is locked');
  });
  const errors = console.error;
  console.error = () => {};
  try {
    await assert.rejects(indexStoredNote('retry-note'), /locked/);
    assert.equal(writes.length, 1);
    failing = false;
    await indexStoredNote('retry-note');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body, 'Text that failed to index');
    await flushSearchIndexing();
    assert.equal(writes.length, 2, 'a completed refresh is not replayed by flush');
  } finally {
    console.error = errors;
    queryClient.clear();
    clearMocks();
    doc.destroy();
  }
});

test('Review and navigation saves finish while search-only backfill is pending', async () => {
  const { startBackfill } = await import('../src/lib/note-index.ts');
  const { ReviewSession } = await import('../src/lib/review-session.ts');
  const { getScheduler } = await import('../src/lib/fsrs.ts');
  await getScheduler();

  const outdated = Array.from({ length: 100 }, (_, i) => `search-only-${i}`);
  const indexed = [];
  const disk = new Y.Doc();
  const edit = new Y.Doc();
  const indexingStarted = Promise.withResolvers();
  const finishIndex = Promise.withResolvers();
  const unexpected = [];
  const card = { id: 'due', moduleId: outdated[0], kind: 'basic', state: 0, dueAt: Date.now() - 1000 };
  const idle = Promise.withResolvers();
  window.requestIdleCallback = callback => { void idle.promise.then(callback); };
  mockIPC((command, args) => {
    if (command === 'core') { command = args.command; args = args.args; }
    switch (command) {
      case 'unindexed_card_modules': return [];
      case 'unindexed_modules': return outdated;
      case 'due_cards': return [card];
      case 'get_content': return { state: [], updates: [], files: [] };
      case 'index_note':
        indexed.push(args.moduleId);
        if (args.moduleId === outdated[0]) {
          indexingStarted.resolve();
          return finishIndex.promise;
        }
        return;
      case 'add_update':
        Y.applyUpdate(disk, Uint8Array.from(args.bytes));
        return { id: 1, bytes: args.bytes };
      default: unexpected.push(command); throw new Error(`Unexpected command: ${command}`);
    }
  });

  const review = new ReviewSession();
  let rebuilt = false;
  const backfill = startBackfill().then(() => { rebuilt = true; });
  const load = review.load();
  let navigation;
  try {
    const loaded = await Promise.race([load.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(loaded, true, 'Review is still waiting on search-only backfill');
    assert.equal(review.getSnapshot().card?.id, card.id);
    assert.equal(rebuilt, false);

    idle.resolve();
    await indexingStarted.promise;
    edit.getText('note').insert(0, 'Save before leaving');
    saveQueue.enqueue('open-note', Array.from(Y.encodeStateAsUpdate(edit)));
    navigation = flushAll({ navigation: true });
    const flushed = await Promise.race([navigation.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(flushed, true, 'navigation is waiting on search-only backfill');
    assert.equal(disk.getText('note').toString(), 'Save before leaving');

    finishIndex.resolve();
    await backfill;
    assert.deepEqual(indexed, outdated);
    assert.deepEqual(unexpected, [], 'search-only notes must not issue card commands');
  } finally {
    idle.resolve();
    finishIndex.resolve();
    await Promise.allSettled([navigation]);
    await saveQueue.suspend();
    await Promise.all([backfill, load]);
    saveQueue.resume();
    queryClient.clear();
    clearMocks();
    delete window.requestIdleCallback;
    edit.destroy();
    disk.destroy();
  }
});
