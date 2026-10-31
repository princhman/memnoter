import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';

// Resolve the application's Vite aliases while exercising its real IPC owners.
const src = new URL('../src/', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) specifier = ${JSON.stringify(src)} + specifier.slice(2) + '.ts';
    return next(specifier, context);
  }
`)}`, import.meta.url);
globalThis.window = { setTimeout, clearTimeout };
const { writeCards, drainCardWrites } = await import('../src/lib/card-writes.ts');
const { saveQueue } = await import('../src/lib/saves.ts');
const { queryClient } = await import('../src/lib/query-client.ts');

test('card sync and review join restore drain and reject admission while suspended', async () => {
  const finishes = [];
  const calls = [];
  mockIPC((command) => {
    calls.push(command);
    return new Promise(resolve => finishes.push(resolve));
  });
  try {
    const sync = writeCards('sync_cards', { moduleId: 'fixture', cards: [] });
    const review = writeCards('review_card', { cardId: 'fixture' });
    assert.equal(queryClient.isMutating(), 2, 'restore sees writes before IPC starts');
    await new Promise(resolve => setImmediate(resolve));
    await saveQueue.suspend();
    let drained = false;
    const drain = drainCardWrites().then(() => { drained = true; });
    await assert.rejects(writeCards('sync_cards', {}), /suspended/);
    await assert.rejects(writeCards('review_card', {}), /suspended/);
    finishes[0]([]);
    await sync;
    assert.equal(drained, false, 'quit still waits for the in-flight review');
    finishes[1]();
    await review;
    await drain;
    assert.equal(drained, true);
    assert.deepEqual(calls, ['sync_cards', 'review_card']);
    saveQueue.resume();
    mockIPC(() => { throw new Error('storage unavailable'); });
    await assert.rejects(writeCards('review_card', {}), /storage unavailable/);
    await drainCardWrites();
    assert.equal(queryClient.isMutating(), 0);
  } finally {
    finishes.forEach(finish => finish());
    saveQueue.resume();
    queryClient.clear();
    clearMocks();
  }
});
