import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks, mockConvertFileSrc } from '@tauri-apps/api/mocks';

globalThis.window = {};
const { call, listen, fileUrl, postNativeEvent } = await import('../src/lib/backend.ts');

test('Tauri takes precedence and retains command arguments and asset URLs', async () => {
  window.webkit = { messageHandlers: { memnoter: { postMessage() { throw Error('wrong transport'); } } } };
  mockIPC((command, args) => ({ command, args }));
  mockConvertFileSrc('macos');
  try {
    assert.deepEqual(await call('save_file', { bytes: [0, 255], mimeType: 'image/png' }), {
      command: 'core', args: { command: 'save_file', args: { bytes: [0, 255], mimeType: 'image/png' } },
    });
    assert.match(fileUrl('/data/files/a'), /asset/);
    assert.deepEqual(await call('confirm_exit'), { command: 'confirm_exit', args: {} });
    mockIPC(() => { throw { code: 'conflict', message: 'Reload the review' }; });
    await assert.rejects(call('review_card'), { message: 'Reload the review' });
  } finally { clearMocks(); delete window.__TAURI_INTERNALS__; }
});

test('native calls correlate out-of-order replies, reject errors, and ignore duplicate replies', async () => {
  const sent = [];
  window.webkit = { messageHandlers: { memnoter: { postMessage: message => sent.push(message) } } };
  const first = call('get_content', { moduleId: 'one' });
  const second = call('modules');
  assert.deepEqual(sent.map(({ kind, command, args }) => ({ kind, command, args })), [
    { kind: 'call', command: 'get_content', args: { moduleId: 'one' } },
    { kind: 'call', command: 'modules', args: {} },
  ]);
  assert.notEqual(sent[0].id, sent[1].id);
  window.__memnoterBridge.resolve(sent[1].id, [{ id: 'two' }]);
  assert.deepEqual(await second, [{ id: 'two' }]);
  window.__memnoterBridge.reject(sent[0].id, 'disk full');
  await assert.rejects(first, /disk full/);
  window.__memnoterBridge.resolve(sent[0].id, 'late');
  postNativeEvent('ready');
  assert.deepEqual(sent[2], { kind: 'event', event: 'ready', payload: null });
});

test('native event subscriptions deliver decoded payloads and unsubscribe independently', async () => {
  const received = [];
  const stop = await listen('menu', event => received.push(event.payload));
  const other = await listen('other', () => assert.fail('wrong event'));
  window.__memnoterBridge.emit('menu', { action: 'bold' });
  stop(); stop();
  window.__memnoterBridge.emit('menu', 'ignored');
  other();
  assert.deepEqual(received, [{ action: 'bold' }]);
});

test('native file URLs encode each component once and refuse paths outside file receipts', () => {
  assert.equal(fileUrl('/private/app/files/a #?%é.png'), 'memnoter-file://localhost/files/a%20%23%3F%25%C3%A9.png');
  assert.equal(fileUrl('files/a%20b'), 'memnoter-file://localhost/files/a%2520b');
  for (const path of ['/private/secret', 'files/../x', 'files/..', 'files/', 'files/a/b']) {
    assert.throws(() => fileUrl(path), /Expected/);
  }
});
