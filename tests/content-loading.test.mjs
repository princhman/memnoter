import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { acknowledgeContent, contentQueryOptions, applySavedContent, acknowledgeCompaction } from '../src/lib/content.ts';

test('an acknowledgement during an outstanding QueryClient read survives publication and reopening', async () => {
  const client = new QueryClient();
  const options = contentQueryOptions('receipt-race');
  const source = new Y.Doc();
  source.getText('text').insert(0, 'saved during read');
  const update = { id: 41, bytes: Array.from(Y.encodeStateAsUpdate(source)) };
  let finish;
  const loading = client.fetchQuery({ ...options, queryFn: () => new Promise(resolve => { finish = resolve; }) });
  acknowledgeContent('receipt-race', update);
  client.setQueryData(options.queryKey, old => old && ({ ...old, updates: [...old.updates, update] }));
  finish({ state: [], updates: [], files: [] });
  await loading;
  const reopened = new Y.Doc();
  const cached = client.getQueryData(options.queryKey);
  applySavedContent(reopened, cached);
  assert.equal(reopened.getText('text').toString(), 'saved during read');
  assert.deepEqual(cached.updates.map(update => update.id), [41]);
  // A subsequent compaction snapshot can safely delete through this receipt.
  const compacted = new Y.Doc();
  Y.applyUpdate(compacted, Y.encodeStateAsUpdate(reopened));
  assert.equal(compacted.getText('text').toString(), 'saved during read');
  const state = Array.from(Y.encodeStateAsUpdate(reopened));
  acknowledgeCompaction('receipt-race', state, cached.updates);
  client.setQueryData(options.queryKey, { state, updates: [], files: [] });
  assert.equal(client.getQueryData(options.queryKey).updates.length, 0, 'compaction retires receipts rather than repeatedly compacting them');
  // Even a stale publication after retirement must contain the checkpoint.
  client.setQueryData(options.queryKey, { state: [], updates: [], files: [] });
  const afterCompaction = new Y.Doc();
  applySavedContent(afterCompaction, client.getQueryData(options.queryKey));
  assert.equal(afterCompaction.getText('text').toString(), 'saved during read');
  client.clear();
});
