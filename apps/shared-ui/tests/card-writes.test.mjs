import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';

globalThis.window = { setTimeout, clearTimeout };
const { writeCards } = await import('../src/lib/card-writes.ts');
const { exclusiveWrite } = await import('../src/lib/write-lifecycle.ts');
const { saveQueue } = await import('../src/lib/saves.ts');
const { queryClient } = await import('../src/lib/query-client.ts');

test('exclusiveWrite waits for in-flight writeCards and rejects new writes while suspended', async () => {
  let finishWrite;
  let finishExclusive;
  let entered = false;
  const calls = [];
  mockIPC(command => {
    calls.push(command);
    return new Promise(resolve => { finishWrite = resolve; });
  });
  let exclusive;
  try {
    const write = writeCards('sync_cards', { moduleId: 'fixture', cards: [] });
    await new Promise(resolve => setImmediate(resolve));
    exclusive = exclusiveWrite(async () => {
      entered = true;
      await new Promise(resolve => { finishExclusive = resolve; });
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, false, 'exclusive action cannot overtake accepted card writes');
    await assert.rejects(writeCards('review_card', {}), /suspended/);
    finishWrite([]);
    await write;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, true);
    assert.equal(saveQueue.isSuspended(), true);
    await assert.rejects(writeCards('sync_cards', {}), /suspended/);
    assert.deepEqual(calls, ['sync_cards'], 'rejected writes never reach storage');
    finishExclusive();
    await exclusive;
    mockIPC(() => 'resumed');
    assert.equal(await writeCards('review_card', {}), 'resumed', 'admission resumes after exclusivity ends');
  } finally {
    finishWrite?.([]);
    finishExclusive?.();
    await exclusive;
    saveQueue.resume();
    queryClient.clear();
    clearMocks();
  }
});
