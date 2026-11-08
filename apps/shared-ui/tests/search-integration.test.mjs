import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import * as Y from 'yjs';

// Resolve the application's Vite aliases while exercising its real IPC owners.
const src = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) specifier = ${JSON.stringify(src)} + specifier.slice(2) + '.ts';
    return next(specifier, context);
  }
`)}`, import.meta.url);
globalThis.window = { setTimeout, clearTimeout };
const { indexStoredNote, flushSearchIndexing } = await import('../src/lib/search-index.ts');
const { acknowledgeContent, acknowledgeCompaction } = await import('../src/lib/content.ts');
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

    const delayed = indexStoredNote('search-receipt');
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

test('a failed index write is kept and written again, unless newer text replaced it', async () => {
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
    await indexStoredNote('retry-note');
    assert.equal(writes.length, 1);
    failing = false;
    // Quitting writes it again.
    await flushSearchIndexing(1_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body, 'Text that failed to index');
    await flushSearchIndexing(1_000);
    assert.equal(writes.length, 2, 'a written note is not retried');

    failing = true;
    await indexStoredNote('retry-note');
    failing = false;
    await indexStoredNote('retry-note');
    await flushSearchIndexing(1_000);
    assert.equal(writes.length, 4, 'newer text replaced the failed write');
  } finally {
    console.error = errors;
    queryClient.clear();
    clearMocks();
    doc.destroy();
  }
});
