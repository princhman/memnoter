import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';

test('WK host opens shared editors, publishes state and outline, and persists edits without desktop APIs', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const cacheDir = await mkdtemp(`${root}node_modules/.memnoter-host-`);
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.messages = [];
      window.webkit = { messageHandlers: { memnoter: { postMessage(message) {
        window.messages.push(message);
        if (message.kind !== 'call') return;
        const { id, command, args } = message;
        let result;
        if (command === 'modules') result = [{ id: 'one' }, { id: 'two' }];
        else if (command === 'get_content') result = { state: [], updates: [], files: [] };
        else if (command === 'add_update') result = { id: window.messages.length, bytes: args.bytes };
        else if (['sync_cards', 'card_schedules'].includes(command)) result = [];
        else if (command === 'index_note') result = null;
        else throw Error(`Unexpected command: ${command}`);
        queueMicrotask(() => window.__memnoterBridge.resolve(id, result));
      } } } };
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await page.waitForFunction(() => window.messages.some(message => message.event === 'ready'));
    await page.evaluate(() => window.memnoterEditor.open('one'));
    await page.locator('.tiptap[contenteditable=true]').waitFor();
    assert.equal(await page.locator('header, aside, nav').count(), 0);
    await page.evaluate(() => {
      window.memnoterEditor.focus();
      window.memnoterEditor.exec('heading', { level: 2 });
    });
    await page.waitForFunction(() => window.messages.some(message => message.event === 'outline' && message.payload.headings.some(heading => heading.level === 1)));
    const result = await page.evaluate(async () => {
      await window.memnoterEditor.open('two');
      return {
        state: window.messages.filter(message => message.event === 'state').at(-1).payload,
        calls: window.messages.filter(message => message.kind === 'call').map(message => message.command),
        unknown: window.memnoterEditor.exec('unknown'),
      };
    });
    assert.equal(result.state.moduleId, 'two');
    assert.ok(result.calls.includes('add_update'));
    assert.equal(result.calls.some(command => command.startsWith('plugin:') || command === 'set_editor_history'), false);
    assert.equal(result.unknown, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true });
  }
});
