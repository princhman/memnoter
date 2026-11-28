import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

register('./support/restore-loader.mjs', import.meta.url);
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const { retrySync, disableSync, syncNow, syncStatusStore } = await import('../src/lib/sync/manager.ts');
const { CLOSE_POLICY, PING, PONG, SYNC_CONTRACT } = await import('../src/lib/sync/protocol.ts');

const status = () => syncStatusStore.state;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Sync did not progress');
}

async function desktopSync(t) {
  globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
  const sockets = [];
  const session = { stall: null, outbox: [], uploads: [], readOutbox: () => session.outbox, pings: 0, acks: 0 };
  globalThis.WebSocket = class {
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen());
    }
    send(text) {
      if (text === PING) {
        session.pings++;
        this.onmessage({ data: PONG });
        return;
      }
      const message = JSON.parse(text);
      if (session.stall === message.t) return;
      if (message.t === 'hello') this.receive({ t: 'ready', head: 0 });
      if (message.t === 'push') this.receive({ t: 'ack', id: message.id, seq: 0 });
    }
    receive(message) {
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(message) }));
    }
    close() {}
  };
  const account = { server: 'https://mock.local', userId: 'user', token: 'token', key: btoa('a'.repeat(32)) };
  globalThis.syncFixture = { call: async command => {
    switch (command) {
      case 'sync_status': return { account: JSON.stringify(account), generation: 'epoch', cursor: 0 };
      case 'sync_credentials_load': return account;
      case 'sync_reconcile': return { updates: [], deleted: [] };
      case 'sync_outbox': return session.readOutbox();
      case 'sync_ack': session.acks++; session.outbox = []; return;
      case 'sync_pending_uploads': return session.uploads;
      case 'sync_pending_deletes': return [];
      case 'sync_missing_files': return session.missing ?? [];
      case 'read_file': return { bytes: [42] };
      case 'sync_upload_done': session.uploads = []; return;
      case 'sync_disable':
      case 'sync_credentials_delete': return;
      default: assert.fail(command);
    }
  } };
  t.after(disableSync);
  await retrySync();
  await until(() => status().state === 'synced');
  return { session, socket: sockets[0] };
}

for (const stall of ['hello', 'push']) {
  test(`manual sync can retry after the server stalls on ${stall}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { session } = await desktopSync(t);
    t.mock.timers.tick(SYNC_CONTRACT.PING_EVERY_MS - 1);
    session.stall = stall;
    session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
    await syncNow();
    await tick();
    assert.equal(status().state, 'syncing');
    t.mock.timers.tick(1);
    assert.equal(session.pings, 1);
    t.mock.timers.tick(29_998);
    assert.equal(status().state, 'syncing');
    t.mock.timers.tick(1);
    await tick();
    assert.equal(status().state, 'error');
    assert.match(status().error, /timed out/i);
    assert.equal(session.acks, 0);
    assert.equal(session.outbox.length, 1);

    session.stall = null;
    await syncNow();
    await until(() => status().state === 'synced');
    assert.equal(status().error, null);
    assert.equal(session.acks, 1);
  });
}

test('a policy close during the outbox read stays visible and manual sync can retry', async t => {
  const { session, socket } = await desktopSync(t);
  session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
  const read = Promise.withResolvers();
  let reading = false;
  session.readOutbox = () => { reading = true; return read.promise; };
  await syncNow();
  await until(() => reading);
  socket.onclose({ code: CLOSE_POLICY, reason: 'Device refused' });
  assert.equal(status().state, 'error');
  read.resolve(session.outbox);
  await tick();
  assert.equal(status().state, 'error');
  assert.equal(status().error, 'Device refused');
  assert.equal(session.acks, 0);

  session.readOutbox = () => session.outbox;
  await syncNow();
  await until(() => status().state === 'synced');
  assert.equal(status().error, null);
  assert.equal(session.acks, 1);
});

test('manual sync waits for queued images and reports a failed upload', async t => {
  t.mock.method(console, 'error', () => {});
  const { session } = await desktopSync(t);
  const previous = status().lastSyncedAt;
  session.uploads = ['image'];
  const upload = Promise.withResolvers();
  let uploading = false;
  t.mock.method(globalThis, 'fetch', () => { uploading = true; return upload.promise; });

  await syncNow();
  await until(() => uploading || status().state === 'synced');
  assert.equal(status().state, 'syncing');
  assert.equal(status().lastSyncedAt, previous);
  await until(() => uploading);
  upload.resolve(new Response('', { status: 500 }));
  await until(() => status().state === 'error');
  assert.match(status().error, /image upload/i);
  assert.equal(status().lastSyncedAt, previous);
  assert.deepEqual(session.uploads, ['image']);

  globalThis.fetch = async () => new Response();
  await syncNow();
  await until(() => status().state === 'synced');
  assert.equal(status().error, null);
  assert.deepEqual(session.uploads, []);
});

test('a manual retry does not wait behind a store call that never settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { session } = await desktopSync(t);
  session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
  session.readOutbox = () => new Promise(() => {});
  await syncNow();
  await tick();
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(status().state, 'error');

  session.readOutbox = () => session.outbox;
  await syncNow();
  await until(() => status().state === 'synced');
  assert.equal(session.acks, 1);
});

test('background sync resumes by itself after a manual sync times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { session } = await desktopSync(t);
  session.stall = 'hello';
  await syncNow();
  await tick();
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(status().state, 'error');

  session.stall = null;
  session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
  for (let i = 0; i < 20 && session.acks === 0; i++) {
    t.mock.timers.tick(2_000);
    await delay(5);
  }
  assert.equal(session.acks, 1, 'the edit synced without pressing Sync now');
});

test('a stalled image download does not hold up a manual sync', async t => {
  const { session } = await desktopSync(t);
  session.missing = [{ fileId: 'remote-image', moduleId: 'note', fileType: 'image/png' }];
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
  await syncNow();
  await until(() => status().state === 'synced' && session.acks === 1);
  assert.equal(status().error, null);
});

test('a manual sync waits for an upload but not for a download already stuck in a pass', async t => {
  const { session } = await desktopSync(t);
  const stuck = Promise.withResolvers();
  let downloading = false;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') { downloading = true; return stuck.promise; }
    return Promise.resolve(new Response());
  });
  session.missing = [{ fileId: 'remote-image', moduleId: 'note', fileType: 'image/png' }];
  session.uploads = [];
  await syncNow();
  await until(() => downloading);
  session.uploads = ['image'];
  session.outbox = [{ id: 1, doc: 'note', bytes: [] }];
  await syncNow();
  await until(() => status().state === 'synced' && session.acks === 1);
  assert.deepEqual(session.uploads, []);
});
