import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

// Actual editor/collaboration/save queue; local persistence bridge, not encrypted sync.
test('quote markers follow editor undo, persisted reload, pending saves and normalized page geometry', async () => {
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
      window.regionCommands = [];
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        window.regionCommands.push(command);
        const updates = JSON.parse(localStorage.getItem('region-updates') || '[]');
        if (command === 'get_content') return { state: [], updates, files: [] };
        if (command === 'add_update') {
          const saved = { id: updates.length + 1, bytes: args.bytes };
          localStorage.setItem('region-updates', JSON.stringify([...updates, saved]));
          return saved;
        }
        throw new Error(command);
      } } });
    }).toString()})();`);
    const url = `http://localhost:${server.httpServer.address().port}/tests/browser/pdf-quote-regions-owned.html`;
    await page.goto(url);
    await page.waitForFunction(() => window.regionsEditor && !window.regionsTest.queryClient.isFetching());
    const source = { documentId: 'pdf-one', page: 1, name: 'Lecture.pdf', region: { x: .25, y: .2, width: .5, height: .4 } };
    let expected = [[1, [{ ...source.region, uses: [{ imageId: "image-one", label: "Lecture notes, quote 1" }] }]]];
    const waitRegions = value => page.waitForFunction(value => document.querySelector('output')?.textContent === JSON.stringify(value), value);
    await page.evaluate(source => window.regionsEditor.commands.insertContent([{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Lecture notes' }] }, { type: 'image', attrs: { fileId: 'quote-one', imageId: 'image-one', pdfSource: source } }]), source);
    await waitRegions(expected);
    await page.evaluate(source => {
      window.regionsEditor.commands.insertContentAt(window.regionsEditor.state.doc.content.size, [
        { type: 'paragraph', content: [{ type: 'inlineImage', attrs: { fileId: 'duplicate', imageId: 'image-two', pdfSource: source } }] },
        { type: 'image', attrs: { fileId: 'quote-one', pdfSource: source } },
        { type: 'image', attrs: { pdfSource: { ...source, documentId: 'other' } } },
        { type: 'image', attrs: { pdfSource: { ...source, region: { ...source.region, x: 2 } } } },
      ]);
      window.regionsTest.pendingPdfQuote.setState(() => ({ moduleId: 'regions-module', file: new File([], 'quote.png'), source, section: false, status: 'draft' }));
    }, source);
    expected = [[1, [{ ...source.region, uses: [{ imageId: "image-one", label: "Lecture notes, quote 1" }, { imageId: "image-two", label: "Lecture notes, quote 2" }] }]]];
    await waitRegions(expected);
    await page.evaluate(() => { window.firstPageRegions = window.regionsSnapshot.get(1); });
    // A draft on another page is retained through error/retry state and removed on discard.
    await page.evaluate(source => window.regionsTest.pendingPdfQuote.setState(current => ({ ...current, source: { ...source, page: 2 }, status: 'error' })), source);
    await waitRegions([...expected, [2, [{ ...source.region, uses: [] }]]]);
    assert.equal(await page.evaluate(() => window.firstPageRegions === window.regionsSnapshot.get(1)), true);
    await page.evaluate(() => window.regionsTest.pendingPdfQuote.setState(current => ({ ...current, moduleId: 'other-module' })));
    await waitRegions(expected);
    await page.evaluate(source => window.regionsTest.pendingPdfQuote.setState(current => ({ ...current, moduleId: 'regions-module', source })), source);
    await waitRegions(expected);
    const marker = page.locator('#page-1 > .pointer-events-none > div');
    const geometry = () => marker.evaluate(element => {
      const box = element.getBoundingClientRect(), page = element.closest('#page-1').getBoundingClientRect();
      return { x: (box.x - page.x) / page.width, y: (box.y - page.y) / page.height, width: box.width / page.width, height: box.height / page.height };
    });
    assert.deepEqual(await geometry(), source.region);
    await page.evaluate(() => { window.previousRegions = window.regionsSnapshot.get(1); window.regionsEditor.commands.setTextSelection(0); });
    assert.equal(await page.evaluate(() => window.previousRegions === window.regionsSnapshot.get(1)), true);
    await page.evaluate(() => window.setRegionScale(1.5));
    await page.waitForFunction(() => document.querySelector('#page-1').clientWidth === 600);
    assert.deepEqual(await geometry(), source.region);
    const box = await marker.boundingBox();
    await page.mouse.click(box.x + 10, box.y + 10);
    assert.equal(await page.evaluate(() => window.pageClicked), true);
    // Separate the user deletion from the insertion undo capture window.
    await page.waitForTimeout(550);
    await page.evaluate(() => { window.regionsTest.pendingPdfQuote.setState(() => null); window.regionsEditor.commands.selectAll(); window.regionsEditor.commands.deleteSelection(); });
    await waitRegions([]);
    await page.evaluate(() => window.regionsEditor.commands.undo());
    await waitRegions(expected);
    await page.evaluate(() => window.regionsEditor.commands.redo());
    await waitRegions([]);
    await page.evaluate(() => window.regionsEditor.commands.undo());
    await waitRegions(expected);
    await page.evaluate(() => window.regionsTest.saveQueue.flush());
    await page.evaluate(() => window.regionsTest.setNote(false));
    await page.locator('.tiptap').waitFor({ state: 'detached' });
    await page.evaluate(() => window.regionsTest.queryClient.setQueryData(['content', 'regions-module'], { state: [], updates: [], files: [] }));
    await waitRegions(expected); // A stale publication must retain acknowledged saves.
    // Reload drops all React/editor/module memory and decodes the saved Yjs updates.
    await page.reload();
    await waitRegions(expected);
    await page.evaluate(() => window.regionsTest.setNote(false));
    await page.locator('.tiptap').waitFor({ state: 'detached' });
    await waitRegions(expected);
    await page.evaluate(() => window.regionsTest.setReader(false));
    await page.locator('output').waitFor({ state: 'detached' });
    await page.evaluate(() => window.regionsTest.setReader(true));
    await waitRegions(expected);
    await page.evaluate(async () => { await window.regionsTest.saveQueue.suspend(); window.regionsTest.setNote(true); });
    await page.locator('.tiptap').waitFor();
    await page.waitForFunction(() => !window.regionsEditor.isDestroyed);
    await page.evaluate(() => { window.regionsEditor.commands.selectAll(); window.regionsEditor.commands.deleteSelection(); });
    await waitRegions([]);
    await page.evaluate(() => window.regionsTest.setNote(false));
    await page.locator('.tiptap').waitFor({ state: 'detached' });
    await waitRegions([]);
    await page.evaluate(async () => { window.regionsTest.saveQueue.resume(); await window.regionsTest.saveQueue.flush(); });
    await waitRegions([]);
    assert.ok((await page.evaluate(() => window.regionCommands)).every(c => ['get_content', 'add_update'].includes(c)), 'fallback performs no cleanup or extra writes');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
