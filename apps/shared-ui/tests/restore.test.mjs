import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
register('./support/restore-loader.mjs', import.meta.url);
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const { retrySync, restoreBackup, disableSync } = await import('../src/lib/sync/manager.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const fails of [false, true]) {
  test(`restore drains sync and restarts against resulting database on ${fails ? 'failure' : 'success'}`, async () => {
    const events = [];
    let drainEngine, drainFiles;
    const engineDone = new Promise(r => { drainEngine = r; });
    const filesDone = new Promise(r => { drainFiles = r; });
    let epoch = 'old';
    const account = JSON.stringify({ server: 'https://mock.local', userId: 'user', key: [], token: 'token' });
    globalThis.syncFixture = {
      call: async command => {
        if (command === 'sync_credentials_load') return JSON.parse(account);
        if (command === 'sync_credentials_delete') return;
        if (command === 'sync_status') return { account, generation: epoch };
        if (command === 'sync_reconcile') return { updates: [], deleted: [] };
        if (command === 'sync_disable') return;
        assert.equal(command, 'restore_backup');
        events.push('restore'); epoch = 'result';
        if (fails) throw new Error('restore failed');
      },
      engine: () => ({ start: () => events.push('start-' + epoch), stop: () => events.push('stop-engine'), idle: () => engineDone }),
      files: () => ({ kick() {}, stop: () => { events.push('stop-files'); return filesDone; } }),
    };
    await retrySync();
    events.length = 0;
    const restore = restoreBackup('snapshot');
    const outcome = fails ? assert.rejects(restore, /restore failed/) : restore;
    await tick();
    assert.deepEqual(events, ['stop-engine', 'stop-files']);
    drainEngine(); await tick();
    assert.equal(events.includes('restore'), false, 'file transfers must drain too');
    drainFiles(); await outcome;
    assert.ok(events.indexOf('restore') > events.indexOf('stop-files'));
    assert.equal(events.at(-1), 'start-result');
    await disableSync();
  });
}

for (const failure of ['rejected', 'stalled']) {
  test(`restore restarts and releases serialized actions after a ${failure} drain`, async t => {
    const events = [];
    let stopped = false;
    const account = JSON.stringify({ server: 'https://mock.local', userId: 'user', key: [], token: 'token' });
    globalThis.syncFixture = {
      call: async command => {
        if (command === 'sync_credentials_load') return JSON.parse(account);
        if (command === 'sync_credentials_delete') return;
        if (command === 'sync_status') return { account, generation: 'epoch' };
        if (command === 'sync_reconcile') return { updates: [], deleted: [] };
        if (command === 'restore_backup') { events.push('restore'); return; }
        if (command === 'sync_disable') return;
        assert.fail(command);
      },
      engine: () => ({ start: () => events.push('start'), stop: () => { stopped = true; }, idle: () => failure === 'rejected' ? Promise.reject(Error('drain failed')) : new Promise(() => {}) }),
      files: () => ({ kick() {}, stop: async () => {} }),
    };
    await retrySync();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const restore = restoreBackup('snapshot');
    await tick();
    assert.equal(stopped, true);
    if (failure === 'stalled') {
      assert.deepEqual(events, ['start']);
      t.mock.timers.tick(5000);
      await tick();
      // Starting the replacement also passes through stopEngine.
      t.mock.timers.tick(5000);
    }
    await restore;
    assert.deepEqual(events, ['start', 'restore', 'start']);
    const disabled = disableSync();
    await tick();
    t.mock.timers.tick(5000);
    await disabled;
    t.mock.timers.reset();
  });
}

class Socket {
  static instances = [];
  constructor() { Socket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(text) {
    if (JSON.parse(text).t === 'hello') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ t: 'ready', head: 0 }) }));
  }
  // Deliberately never emit close: shutdown must not wait for a handshake.
  close() {}
}
globalThis.WebSocket = Socket;
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('operation did not progress');
};
for (const kind of ['upload', 'delete', 'blob-body']) {
  test(`restore cancels stalled ${kind}, retains pending work and restarts`, async () => {
    let signal;
    let requested = false;
    let pending = true;
    let release = false;
    let restored = false;
    let done = 0;
    let cursor = 0;
    const account = JSON.stringify({ server: 'https://mock.local', userId: 'user', key: btoa(String.fromCharCode(...new Uint8Array(32))), token: 'token' });
    globalThis.syncFixture = { call: async (command, args) => {
      switch (command) {
        case 'sync_credentials_load': return JSON.parse(account);
        case 'sync_credentials_delete': return;
        case 'sync_status': return { account, generation: restored ? 'new' : 'old', cursor };
        case 'sync_reconcile': return { updates: [], deleted: [] };
        case 'sync_outbox': return [];
        case 'sync_pending_uploads': return !pending || kind !== 'upload' ? [] : ['image'];
        case 'sync_pending_deletes': return pending && kind === 'delete' ? ['image'] : [];
        case 'sync_missing_files': return [];
        case 'read_file': return { bytes: [42] };
        case 'sync_upload_done':
        case 'sync_delete_done': done++; pending = false; return;
        case 'sync_ack': done++; return;
        case 'sync_apply': done++; cursor = args.cursor; return { updates: [], deleted: [] };
        case 'sync_set_cursor': cursor = args.cursor; return;
        case 'restore_backup': restored = true; return;
        case 'sync_disable': return;
        default: assert.fail(command);
      }
    } };
    globalThis.fetch = async (_url, init) => {
      requested = true;
      signal = init.signal;
      if (release) return new Response();
      if (kind === 'delete') assert.equal(init.method, 'DELETE');
      if (kind !== 'blob-body') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return new Response(new ReadableStream({ start() {} }));
    };
    const count = Socket.instances.length;
    await retrySync();
    await until(() => Socket.instances.length > count);
    await tick();
    if (kind !== 'blob-body') globalThis.requestFile('image');
    else Socket.instances.at(-1).onmessage({ data: JSON.stringify({ t: 'entries', entries: [{ seq: 9, doc: 'note', data: btoa(String.fromCharCode(2) + 'a'.repeat(32)) }] }) });
    await until(() => requested);
    let deadline;
    try {
      await Promise.race([restoreBackup('snapshot'), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('restore blocked')), 1000); })]);
    } finally { clearTimeout(deadline); }
    assert.equal(signal.aborted, true);
    assert.equal(restored, true);
    assert.equal(done, 0, 'cancelled work must remain pending');
    assert.equal(cursor, 0, 'a held blob must not advance the cursor');
    assert.equal(Socket.instances.length, count + 2, 'sync restarts after restore');
    if (kind !== 'blob-body') {
      assert.equal(pending, true);
      release = true;
      globalThis.requestFile('image');
      await until(() => !pending);
      assert.equal(done, 1, 'restarted sync retries the cancelled item');
    }
    await disableSync();
  });
}

const { getKeyInfo, putObject, getObject } = await import('../src/lib/sync/account.ts');
for (const body of [false, true]) {
  test(`control deadline covers a stalled ${body ? 'response body' : 'connection'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    globalThis.fetch = async (_url, init) => {
      signal = init.signal;
      return body ? new Response(new ReadableStream({ start() {} })) : new Promise(() => {});
    };
    const outcome = assert.rejects(getKeyInfo('https://mock.local', 'token'), { name: 'AbortError' });
    await tick();
    t.mock.timers.tick(19_999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await outcome;
    assert.equal(signal.aborted, true);
  });
}

test('large upload gets a size budget and downloads renew the deadline on progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  globalThis.fetch = async (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  const upload = assert.rejects(putObject('https://mock.local', 'token', 'files', 'large', new Uint8Array(1_048_576)), { name: 'AbortError' });
  t.mock.timers.tick(151_999);
  assert.equal(signal.aborted, false, '1 MiB gets 120 seconds plus 32 seconds at 32 KiB/s');
  t.mock.timers.tick(1);
  await upload;
  let stream;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const download = getObject('https://mock.local', 'token', 'files', 'large');
  await tick();
  t.mock.timers.tick(119_000);
  stream.enqueue(new Uint8Array([42]));
  await tick();
  t.mock.timers.tick(119_000);
  stream.close();
  assert.deepEqual(await download, new Uint8Array([42]), 'progressing downloads may exceed the initial two minutes');
});
