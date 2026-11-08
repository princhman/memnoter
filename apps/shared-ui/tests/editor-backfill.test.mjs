import { browserHarness } from "./support/browser.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as Y from 'yjs';

const { createServer, webkit } = browserHarness(import.meta.url);

function note(text) {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  doc.getXmlFragment('default').insert(0, [paragraph]);
  const bytes = [...Y.encodeStateAsUpdate(doc)];
  doc.destroy();
  return bytes;
}

test('editor-only host backfills closed two-way notes and publishes synced card changes without replacing the open draft', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    const writes = [];
    const events = [];
    const reads = [];
    let lists = 0;
    const states = { closed: note('Front ::: Back'), synced: note('Remote ::: Answer') };
    await page.exposeFunction('nativeMessage', message => {
      if (message.kind === 'event') { events.push(message.event); return; }
      const { id, command, args } = message;
      let result = [];
      if (command === 'unindexed_card_modules') { lists++; result = [{ id: 'closed' }]; }
      else if (command === 'get_content') {
        reads.push(args.moduleId);
        result = { state: states[args.moduleId] ?? [], updates: [], files: [] };
      } else if (command === 'sync_cards') writes.push(args);
      else if (command === 'add_update') result = { id: writes.length + 1, bytes: args.bytes };
      else if (!['modules', 'card_schedules', 'index_note'].includes(command)) throw Error(`Unexpected command: ${command}`);
      void page.evaluate(({ id, result }) => window.__memnoterBridge.resolve(id, result), { id, result });
    });
    await page.addInitScript(() => {
      window.installTestBridge({ native: message => { void window.nativeMessage(message); } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await page.waitForFunction(() => !!window.memnoterEditor);
    await page.evaluate(() => window.memnoterEditor.open('draft'));
    const editor = page.locator('.tiptap[contenteditable=true]');
    await editor.click();
    await page.keyboard.type('Keep my draft');
    const draft = await editor.textContent();
    const selection = await page.evaluate(() => window.getSelection().focusOffset);
    await assertEventually(() => writes.some(write => write.moduleId === 'closed' && write.cards.length === 2));
    const cards = writes.find(write => write.moduleId === 'closed' && write.cards.length === 2).cards;
    assert.deepEqual(cards.map(card => card.front[0].text), ['Front', 'Back']);
    await assertEventually(() => events.includes('cardsChanged'));
    events.length = 0;
    await page.evaluate(bytes => window.memnoterEditor.applyRemote({
      updates: [{ moduleId: 'synced', update: { id: 99, bytes } }],
      modulesChanged: true, deleted: [], reviewsChanged: false, filesChanged: false,
    }), states.synced);
    await assertEventually(() => writes.some(write => write.moduleId === 'synced' && write.cards.length === 2));
    await assertEventually(() => events.includes('cardsChanged'));
    assert.equal(await editor.textContent(), draft);
    assert.equal(await page.evaluate(() => window.getSelection().focusOffset), selection);
    assert.equal(lists, 1, 'startup scan runs once, sync uses the shared incremental reindexer');
    assert.equal(reads.filter(id => id === 'closed').length, 1);
  } finally {
    await browser?.close();
    await server.close();

  }
});

async function assertEventually(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate());
}
