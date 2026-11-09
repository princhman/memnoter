import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

// The real schema, note owner and Yjs persistence must agree on text identities.
// Image route/lifecycle coverage lives in pdf-quote-navigation.test.mjs.
test('text quote markers survive persisted reload and reveal editable text alongside an image use', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${(() => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        const updates = JSON.parse(localStorage.getItem('text-region-updates') || '[]');
        if (command === 'get_content') return { state: [], updates, files: [] };
        if (command === 'add_update') {
          const saved = { id: updates.length + 1, bytes: args.bytes };
          localStorage.setItem('text-region-updates', JSON.stringify([...updates, saved]));
          return saved;
        }
        throw new Error(command);
      } } });
    }).toString()})();`);
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-quote-regions-owned.html`);
    await page.waitForFunction(() => window.regionsEditor && !window.regionsTest.queryClient.isFetching());
    const source = { documentId: 'pdf-one', page: 1, name: 'Lecture.pdf', region: { x: .25, y: .2, width: .5, height: .4 } };
    const ids = await page.evaluate(source => {
      const ids = { image: crypto.randomUUID(), text: crypto.randomUUID(), next: crypto.randomUUID() };
      const heading = text => ({ type: 'heading', attrs: { level: 1, 'data-toc-id': text }, content: [{ type: 'text', text }] });
      const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
      window.regionsEditor.commands.setContent([
        heading('Overview'), { type: 'image', attrs: { imageId: ids.image, fileId: 'image', pdfSource: source, masks: [{ x: .1, y: .1, width: .2, height: .2 }] } },
        heading('Reading'), ...Array.from({ length: 30 }, () => paragraph('Filler')),
        { type: 'pdfTextQuote', attrs: { quoteId: ids.text, pdfSource: source }, content: [paragraph('Editable quoted text')] },
        { type: 'pdfTextQuote', attrs: { quoteId: ids.next, pdfSource: { ...source, page: 2 } }, content: [paragraph('Continued on page two')] },
      ]);
      return ids;
    }, source);
    const expected = [
      [1, [{ ...source.region, uses: [{ quoteId: ids.image, label: 'Overview, quote 1' }, { quoteId: ids.text, label: 'Reading, quote 1' }] }]],
      [2, [{ ...source.region, uses: [{ quoteId: ids.next, label: 'Reading, quote 2' }] }]],
    ];
    const waitRegions = value => page.waitForFunction(value => document.querySelector('output')?.textContent === JSON.stringify(value), value);
    await waitRegions(expected);
    // A multi-page draft has no target until insertion, and deduplicates a saved rectangle.
    await page.evaluate(source => window.regionsTest.pendingPdfQuote.setState(() => ({
      id: crypto.randomUUID(), moduleId: 'regions-module', kind: 'text', status: 'error',
      parts: [{ text: 'same', source }, { text: 'new', source: { ...source, page: 2, region: { ...source.region, y: .65, height: .2 } } }],
    })), source);
    await waitRegions([expected[0], [2, [...expected[1][1], { ...source.region, y: .65, height: .2, uses: [] }]]]);
    await page.evaluate(() => window.regionsTest.pendingPdfQuote.setState(() => null));
    await waitRegions(expected);
    await page.evaluate(() => window.regionsTest.saveQueue.flush());
    // The read-only saved scan has no editor to supply markers.
    await page.evaluate(() => window.regionsTest.setNote(false));
    await page.locator('.tiptap').waitFor({ state: 'detached' });
    await waitRegions(expected);
    await page.reload();
    await page.waitForFunction(() => window.regionsEditor && !window.regionsTest.queryClient.isFetching());
    await waitRegions(expected);
    const before = await page.evaluate(() => {
      const editor = window.regionsEditor;
      editor.commands.setFolds(['Reading']);
      editor.commands.showSection(0);
      return editor.getJSON();
    });
    await page.getByRole('button', { name: 'Show quote in note (2 uses)', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reading, quote 1', exact: true }).click();
    await page.waitForFunction(id => window.regionsEditor.state.selection.node?.attrs.quoteId === id, ids.text);
    const result = await page.evaluate(() => ({
      doc: window.regionsEditor.getJSON(), folds: window.regionsView.getFoldedIds(window.regionsEditor.state),
      focus: window.regionsView.getFocusedSectionRange(window.regionsEditor.state),
      focused: window.regionsEditor.view.hasFocus(), scroll: document.querySelector('.app-scroll-container').scrollTop,
      outerScroll: window.scrollY,
    }));
    assert.deepEqual(result.doc, before, 'reveal preserves the persisted content and image masks');
    assert.deepEqual(result.folds, []);
    assert.equal(result.focus, null);
    assert.equal(result.focused, true);
    assert.ok(result.scroll > 0);
    assert.equal(result.outerScroll, 0);
    assert.equal(before.content.find(node => node.type === 'pdfTextQuote').attrs.imageId, undefined);
    // Edit through the actual paragraph inside the source-bearing blockquote.
    await page.evaluate(id => {
      const editor = window.regionsEditor;
      let position;
      editor.state.doc.descendants((node, pos) => { if (node.attrs.quoteId === id) position = pos + 2; });
      editor.commands.insertContentAt(position, 'User edit: ');
    }, ids.text);
    await waitRegions(expected);
    assert.ok(await page.evaluate(() => window.regionsEditor.getText().includes('User edit: Editable quoted text')));
    await page.getByRole('button', { name: 'Show quote in note (2 uses)', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Overview, quote 1', exact: true }).click();
    await page.waitForFunction(id => window.regionsEditor.state.selection.node?.attrs.imageId === id, ids.image);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
