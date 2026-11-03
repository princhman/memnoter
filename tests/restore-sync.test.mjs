import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
const root = new URL('../src/', import.meta.url).href;
// Keep the manager real; replace its platform, transport and editor boundaries.
register(`data:text/javascript,${encodeURIComponent(`
export function resolve(specifier, context, next) {
  if (specifier.endsWith('/sync/manager.ts')) return next(specifier, context);
  if (context.parentURL?.endsWith('/sync/manager.ts')) {
    const modules = {
      '@/lib/backend': 'export const call = (...a) => globalThis.syncFixture.call(...a); export const listen = async () => () => {};',
      './engine': 'export const createSyncEngine = () => globalThis.syncFixture.engine();',
      './files': 'export const createFileSync = () => globalThis.syncFixture.files();',
      './crypto': 'export const importKey = async () => ({});',
      '@/lib/write-lifecycle': 'export const exclusiveWrite = async fn => fn();',
      '@/lib/saves': 'export const saveQueue = { clear() {}, isSuspended: () => false };',
      '@/lib/content': 'export const acknowledgeContent = () => {};',
      '@/lib/card-sync': 'export const dueCountsKey = []; export const isModuleOpen = () => false;',
      '@/lib/card-backfill': 'export const reindexStoredCards = async () => {};',
      '@/lib/query-client': 'export const queryClient = {};',
      '@/lib/search-index': 'export const indexStoredNote = async () => {};',
      '@/lib/store': 'export const forgetModule = () => {};',
      './account': 'export const getObject = () => {}; export const putObject = () => {}; export const wipeCloudData = () => {}; export const isTokenValid = () => true;',
      './file-requests': 'export const setSyncedFileHandler = () => {}; export const syncedFileArrived = () => {};',
    };
    if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    if (specifier === './protocol') return next(${JSON.stringify(root)} + 'lib/sync/protocol.ts', context);
  }
  return next(specifier, context);
}
`)}`, import.meta.url);
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
    const account = JSON.stringify({ server: 'https://mock.local', key: [], token: 'token' });
    globalThis.syncFixture = {
      call: async command => {
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
    const account = JSON.stringify({ server: 'https://mock.local', key: [], token: 'token' });
    globalThis.syncFixture = {
      call: async command => {
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
