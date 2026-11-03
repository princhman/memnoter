import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
const root = new URL('../src/', import.meta.url).href;
// Keep the manager real; replace its platform, transport and editor boundaries.
register(`data:text/javascript,${encodeURIComponent(`
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
export function resolve(specifier, context, next) {
  if (specifier.endsWith('/sync/manager.ts')) return next(specifier, context);
  if (context.parentURL?.endsWith('/sync/manager.ts')) {
    const modules = {
      '@/lib/backend': 'export const call = (...a) => globalThis.syncFixture.call(...a); export const listen = async () => () => {};',
      '@/lib/write-lifecycle': 'export const exclusiveWrite = async fn => fn();',
      '@/lib/saves': 'export const saveQueue = { clear() {}, isSuspended: () => false };',
      '@/lib/content': 'export const acknowledgeContent = () => {};',
      '@/lib/card-sync': 'export const dueCountsKey = []; export const isModuleOpen = () => false;',
      '@/lib/card-backfill': 'export const reindexStoredCards = async () => {};',
      '@/lib/query-client': 'export const queryClient = {};',
      '@/lib/search-index': 'export const indexStoredNote = async () => {};',
      '@/lib/store': 'export const forgetModule = () => {};',
      './file-requests': 'export const setSyncedFileHandler = fn => globalThis.requestFile = fn; export const syncedFileArrived = () => {};',
    };
    if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    if (specifier === './protocol') return next(${JSON.stringify(root)} + 'lib/sync/protocol.ts', context);
  }
  if (specifier === '@/lib/backend') return { url: 'data:text/javascript,' + encodeURIComponent('export const call = (...a) => globalThis.syncFixture.call(...a);'), shortCircuit: true };
  if (context.parentURL?.includes('/lib/sync/') && specifier.startsWith('./')) return next(new URL(specifier + '.ts', context.parentURL).href, context);
  return next(specifier, context);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith('.ts')) return { ...result, format: 'module', source: ts.transpileModule(result.source.toString().replaceAll('import.meta.env.', '({}).'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return result;
}
`)}`, import.meta.url);
globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const { retrySync, restoreBackup, disableSync } = await import('../src/lib/sync/manager.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

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
for (const kind of ['upload', 'blob-body']) {
  test(`restore cancels stalled ${kind}, retains pending work and restarts`, async () => {
    let signal;
    let requested = false;
    let pending = true;
    let release = false;
    let restored = false;
    let done = 0;
    let cursor = 0;
    const account = JSON.stringify({ server: 'https://mock.local', key: btoa(String.fromCharCode(...new Uint8Array(32))), token: 'token' });
    globalThis.syncFixture = { call: async (command, args) => {
      switch (command) {
        case 'sync_status': return { account, generation: restored ? 'new' : 'old', cursor };
        case 'sync_reconcile': return { updates: [], deleted: [] };
        case 'sync_outbox': return [];
        case 'sync_pending_uploads': return !pending || kind !== 'upload' ? [] : ['image'];
        case 'sync_missing_files': return [];
        case 'read_file': return { bytes: [42] };
        case 'sync_upload_done': done++; pending = false; return;
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
      if (kind === 'upload') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return new Response(new ReadableStream({ start() {} }));
    };
    const count = Socket.instances.length;
    await retrySync();
    await until(() => Socket.instances.length > count);
    await tick();
    if (kind === 'upload') globalThis.requestFile('image');
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
    if (kind === 'upload') {
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
