import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as Y from 'yjs';
import { browserHarness } from './support/browser.mjs';

const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, url;
const banner = 'This note was edited with a newer version of Memnoter. Update the app to edit it.';
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  browser = await webkit.launch();
  url = `http://localhost:${server.httpServer.address().port}`;
});
after(async () => { await browser?.close(); await server?.close(); });

function note(kind) {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Question :: answer', kind === 'mark' ? { futureMark: {} }
    : kind === 'mark attribute' ? { bold: { futureOption: true } } : {});
  if (kind === 'text attribute') text.setAttribute('futureTextAttribute', 'retain me');
  paragraph.insert(0, [text]);
  // Stable IDs ensure byte changes indicate data loss, not card ID assignment.
  paragraph.setAttribute('cardId', 'known-card');
  if (kind === 'attribute') paragraph.setAttribute('futureAttribute', { source: 'retain me' });
  if (kind === 'root') doc.getMap('futureWorksheetRoot').set('fileId', 'future-file');
  if (kind === 'worksheet') doc.getMap('worksheets').set('schemaVersion', 1);
  const root = doc.getXmlFragment('default');
  if (kind === 'node') {
    const unknown = new Y.XmlElement('futureBlock');
    unknown.insert(0, [paragraph]);
    root.insert(0, [unknown]);
  } else root.insert(0, [paragraph]);
  return doc;
}

async function open(t, state, native = false, backfill = false) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.on('pageerror', error => console.error(error.message));
  await page.addInitScript(({ state, native, backfill }) => {
    window.calls = [];
    const invoke = async (command, args) => {
      window.calls.push({ command, args });
      if (command.startsWith('plugin:')) return 1;
      if (command === 'modules') return [{ id: 'm1', name: 'Future note' }];
      if (command === 'get_content') return { state, updates: [], files: [{ id: 'future-file', file_type: 'image/png' }] };
      if (command === 'sync_status') return { account: null, enabled: false };
      if (command === 'add_update') return { id: window.calls.length, bytes: args.bytes };
      if (command === 'unindexed_card_modules') return backfill ? [{ id: 'm1' }] : [];
      if (command === 'unindexed_modules') return backfill ? ['m1'] : [];
      if (['sync_cards', 'due_counts', 'due_cards', 'card_schedules', 'search_notes', 'documents', 'list_documents', 'cleanup_files'].includes(command)) return [];
      return null;
    };
    window.installTestBridge(native ? { native: message => {
      if (message.kind !== 'call') return;
      invoke(message.command, message.args).then(result => window.__memnoterBridge.resolve(message.id, result));
    } } : { tauri: { invoke } });
  }, { state, native, backfill });
  await page.goto(`${url}${native ? '/editor.html' : backfill ? '/' : '/m1'}`);
  if (native) {
    await page.waitForFunction(() => window.memnoterEditor);
    await page.evaluate(() => window.memnoterEditor.open('m1'));
  } else if (backfill) {
    await page.waitForFunction(() => window.calls.some(call => call.command === 'get_content'));
  } else {
    try { await page.waitForSelector('.tiptap', { state: 'attached' }); }
    catch (error) { console.error(await page.locator('body').innerText(), await page.evaluate(() => window.calls)); throw error; }
  }
  return page;
}

async function liveState(page) {
  return page.evaluate(async () => (await import('/tests/browser/unknown-schema.ts')).liveState());
}

for (const [kind, native] of [['node', false], ['mark', false], ['attribute', false], ['text attribute', false], ['mark attribute', false], ['root', false], ['worksheet', false], ['node', true]]) {
  test(`opening an unknown ${kind}${native ? ' in the iOS host' : ''} preserves every byte through edits and idle`, async t => {
    const source = note(kind);
    const state = [...Y.encodeStateAsUpdate(source)];
    const page = await open(t, state, native);
    // Assert storage before the UI so the baseline demonstrates actual deletion.
    assert.deepEqual((await liveState(page)).bytes, state, 'opening rewrote the Yjs document');
    await page.getByRole('status').filter({ hasText: banner }).waitFor();
    assert.equal((await liveState(page)).editable, false);
    assert.deepEqual(await page.evaluate(async bytes => (await import('/tests/browser/unknown-schema.ts')).openPreloaded(bytes), state),
      { bytes: state, editable: false, rendered: true }, 'preloaded documents must be guarded before the first binding render');
    await page.evaluate(async () => {
      const editor = document.querySelector('.tiptap').editor;
      // Both ordinary input and programmatic/plugin transactions must be blocked.
      editor.commands.insertContent('must not be saved');
      editor.commands.setContent('<p>replacement</p>');
      editor.setEditable(true);
      editor.commands.insertContent('still blocked');
      const { flushAll } = await import('/src/lib/write-lifecycle.ts');
      await flushAll();
    });
    await page.waitForTimeout(3300);
    assert.deepEqual(await liveState(page), { bytes: state, editable: false });
    const writes = await page.evaluate(() => window.calls.filter(call => ['add_update', 'sync_cards', 'index_note', 'cleanup_files'].includes(call.command)));
    assert.deepEqual(writes, [], 'quarantined content must not feed derived writes or file cleanup');
    source.destroy();
  });
}

test('hidden startup backfill leaves an unknown note and its indexes untouched', async t => {
  const source = note('node');
  const state = [...Y.encodeStateAsUpdate(source)];
  const page = await open(t, state, false, true);
  await page.evaluate(async () => {
    const { startBackfill } = await import('/src/lib/note-index.ts');
    await startBackfill();
    const { flushAll } = await import('/src/lib/write-lifecycle.ts');
    await flushAll();
  });
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => ['add_update', 'sync_cards', 'index_note', 'cleanup_files'].includes(call.command))), []);
  source.destroy();
});

for (const [native, kind] of [[false, "node"], [true, "node"], [false, "root"]]) {
  test(`${native ? 'iOS host' : 'desktop'} quarantines a remote unknown ${kind} before conversion`, async t => {
    const source = note('normal');
    const page = await open(t, [...Y.encodeStateAsUpdate(source)], native);
    await page.waitForFunction(() => document.querySelector('.tiptap')?.editor?.isEditable);
    assert.equal(await page.getByText(banner).count(), 0);
    // First prove this is an editable note, then introduce future content from
    // a second replica of its actual live state (including this local edit).
    await page.evaluate(() => document.querySelector('.tiptap').editor.commands.insertContent('local edit '));
    const editable = await liveState(page);
    assert.equal(editable.editable, true);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Uint8Array.from(editable.bytes));
    const vector = Y.encodeStateVector(remote);
    const unknown = new Y.XmlElement('futureBlock');
    const text = new Y.XmlText(); text.insert(0, 'must survive sync');
    unknown.insert(0, [text]);
    if (kind === 'root') remote.getMap('futureWorksheetRoot').set('fileId', 'future-file');
    else remote.getXmlFragment('default').insert(1, [unknown]);
    const update = [...Y.encodeStateAsUpdate(remote, vector)];
    await page.evaluate(async ({ native, bytes }) => {
      const result = { updates: [{ moduleId: 'm1', update: { id: 9000, bytes } }], modulesChanged: false, deleted: [], reviewsChanged: false, filesChanged: false };
      if (native) window.memnoterEditor.applyRemote(result);
      else (await import('/src/lib/sync/apply-remote.ts')).onRemote(result);
    }, { native, bytes: update });
    await page.getByText(banner).waitFor();
    assert.deepEqual(await liveState(page), { bytes: [...Y.encodeStateAsUpdate(remote)], editable: false });
    await page.evaluate(async () => {
      document.querySelector('.tiptap').editor.commands.insertContent('blocked');
      const { flushAll } = await import('/src/lib/write-lifecycle.ts'); await flushAll();
    });
    await page.waitForTimeout(2300);
    assert.deepEqual((await liveState(page)).bytes, [...Y.encodeStateAsUpdate(remote)]);
    source.destroy(); remote.destroy();
  });
}
