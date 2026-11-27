import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { textPdfBytes } from './browser/pdf-text-selection-pdf.mjs';

test('native PDF text selections quote only on demand, with per-page sources and reader lifecycle guards', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 1200 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => { if (command === 'get_content') return { state: [], updates: [], files: [] }; if (command === 'document_path') return '/text.pdf'; throw new Error(command); } } });`);
    await page.route('**/text.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-text-selection.html`);
    const viewer = page.locator('#viewer'), action = viewer.getByRole('button', { name: 'Quote text', exact: true });
    const first = viewer.locator('[data-pdf-page="1"] .textLayer span').filter({ hasText: 'Page 1 first line' });
    const second = viewer.locator('[data-pdf-page="2"] .textLayer span').filter({ hasText: 'Second line <plain>.' });
    await first.waitFor(); await second.waitFor();
    const draft = async () => JSON.parse(await page.locator('#text-draft').textContent());
    const clear = () => page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    async function select(from = first, to = first) {
      await from.hover();
      const a = await from.boundingBox(), b = await to.boundingBox();
      await page.mouse.move(a.x + .5, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width - .5, b.y + b.height / 2, { steps: 20 }); await page.mouse.up();
      await action.waitFor();
    }
    await select();
    assert.equal(await draft(), null, 'selection alone must not stage');
    const nativeText = await page.evaluate(() => window.getSelection().toString());
    await page.evaluate(() => { window.copyCount = 0; document.addEventListener('copy', () => window.copyCount++); });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    assert.equal(await page.evaluate(() => window.copyCount), 1);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), nativeText);
    assert.equal(await draft(), null);
    // Normalize drag direction before asking the keyboard to shrink its end.
    await page.evaluate(() => {
      const selection = window.getSelection(), range = selection.getRangeAt(0);
      selection.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
    });
    await page.keyboard.press('Shift+ArrowLeft'); await action.waitFor();
    await action.click();
    let quote = await draft();
    assert.equal(quote.kind, 'text'); assert.match(quote.id, /^[0-9a-f-]{36}$/);
    assert.equal(quote.parts.length, 1); assert.equal(quote.parts[0].text, 'Page 1 first lin');
    const stableId = quote.id;
    // Selecting again while either draft kind is pending must never overwrite it.
    const a = await first.boundingBox(); await page.mouse.move(a.x, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(a.x + a.width, a.y + a.height / 2); await page.mouse.up();
    assert.equal(await action.count(), 0); assert.equal((await draft()).id, stableId);
    await clear();
    await select(first, second); await action.click(); quote = await draft();
    assert.deepEqual(quote.parts.map(part => part.text), ['Page 1 first line\nSecond line <plain>.', 'Page 2 first line\nSecond line <plain>.']);
    assert.deepEqual(quote.parts.map(part => part.source.page), [1, 2]);
    assert.ok(quote.parts.every(part => part.source.documentId === 'text-pdf'));
    const region = quote.parts[0].source.region;
    assert.ok(Math.abs(region.x - .1) < .005); assert.ok(region.height > .1 && region.height < .14);
    assert.equal(await viewer.locator('.textLayer plain').count(), 0);
    await clear();
    await viewer.getByRole('button', { name: /^Zoom in/ }).click();
    await viewer.locator('.overflow-auto').evaluate(element => { element.scrollTop = 0; });
    await first.waitFor();
    await select(); await action.click(); quote = await draft();
    assert.ok(Math.abs(quote.parts[0].source.region.x - region.x) < .005);
    assert.equal(quote.parts[0].text, 'Page 1 first line'); await clear();
    await select(); await page.keyboard.press('Escape'); await action.waitFor({ state: 'detached' });
    await select(); await viewer.getByRole('button', { name: 'Quote region', exact: true }).click();
    assert.equal(await action.count(), 0); assert.equal(await draft(), null);
    await viewer.getByRole('button', { name: 'Exit selection', exact: true }).click();
    await page.locator('#outside').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    await page.waitForTimeout(50); assert.equal(await action.count(), 0);
    await select();
    await viewer.evaluate(element => { element.style.height = '700px'; });
    await action.waitFor({ state: 'detached' }); assert.equal(await draft(), null);
    await select();
    const gesture = type => viewer.locator('.overflow-auto').evaluate((element, type) => {
      const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'scale', { value: 1 }); element.dispatchEvent(event);
    }, type);
    await gesture('gesturestart');
    await action.waitFor({ state: 'detached' }); assert.equal(await draft(), null);
    await gesture('gestureend');
    await page.waitForTimeout(250);
    await viewer.locator('.overflow-auto').evaluate(element => { element.scrollTop = 0; });
    await select();
    await page.getByRole('button', { name: 'Stage image', exact: true }).click();
    await action.waitFor({ state: 'detached' });
    assert.equal((await draft()).kind, 'image');
    await clear();
    await select();
    await page.getByRole('button', { name: 'Replace document', exact: true }).click();
    await action.waitFor({ state: 'detached' }); assert.equal(await draft(), null);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});

test('PDF text menu stays anchored during selection and scrolling', async () => {
  const server = await browserHarness(import.meta.url).createServer({ server: { port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.addInitScript(`(${installTestBridge.toString()})({ tauri: { invoke: async command => {
      if (command === 'list_documents') return [{ id: 'drag', moduleId: 'note', name: 'Reading.pdf', size: 1000, pageCount: 3, available: true }];
      if (command === 'document_path') return '/reading.pdf';
      if (command === 'load_annotations') return { state: null, revision: 0, generation: 'reading-test' };
      return [];
    } } });`);
    await page.route('**/reading.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/files/drag`);
    const first = page.locator('[data-pdf-page="1"] .textLayer span').filter({ hasText: 'Page 1 first line' });
    await first.waitFor();
    const box = await first.boundingBox();
    const y = box.y + box.height / 2;
    const menu = page.getByRole('button', { name: 'Quote text', exact: true });
    const pause = process.env.PROOF_DIR ? 850 : 70;
    await page.mouse.move(box.x + box.width - 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, y, { steps: 12 });
    await menu.waitFor();
    const position = await menu.boundingBox();
    await page.waitForTimeout(pause);
    await page.mouse.move(box.x + 1, y, { steps: 25 });
    await page.waitForTimeout(pause);
    assert.deepEqual(await menu.boundingBox(), position);
    await page.mouse.up();
    await page.waitForTimeout(pause);
    assert.deepEqual(await menu.boundingBox(), position);
    assert.match(await page.evaluate(() => window.getSelection().toString()), /Page 1 first line/);
    const viewport = page.locator('.pdf-viewport');
    const watchScroll = () => viewport.evaluate(element => {
      const menu = element.ownerDocument.querySelector('[aria-label="PDF text actions"]');
      const anchor = menu.getBoundingClientRect().top + element.scrollTop;
      const offsets = [];
      const sample = () => offsets.push(menu.getBoundingClientRect().top + element.scrollTop - anchor);
      element.addEventListener('scroll', sample);
      window.stopWatchingPdfScroll = () => {
        element.removeEventListener('scroll', sample);
        return offsets;
      };
    });
    const assertScroll = async () => {
      const offsets = await page.evaluate(() => window.stopWatchingPdfScroll());
      assert.ok(offsets.length > 0, 'the gesture must scroll the PDF');
      assert.ok(offsets.every(offset => Math.abs(offset) < 1), 'the menu must move with the PDF on every scroll: ' + offsets.join(', '));
    };
    const nextLine = page.locator('[data-pdf-page="1"] .textLayer span').filter({ hasText: 'Second line' });
    const nextLineBox = await nextLine.boundingBox();
    const lineY = nextLineBox.y + nextLineBox.height / 2;
    await page.mouse.move(nextLineBox.x + 1, lineY);
    await page.mouse.down();
    await page.mouse.move(nextLineBox.x + nextLineBox.width - 1, lineY, { steps: 20 });
    await page.mouse.up();
    await menu.waitFor();
    await page.waitForTimeout(pause);
    await watchScroll();
    for (let step = 0; step < 3; step++) {
      await page.mouse.wheel(0, 12);
      await page.waitForTimeout(pause);
    }
    await assertScroll();

    const secondPage = page.locator('[data-pdf-page="2"] .textLayer span').filter({ hasText: 'Page 2 first line' });
    await secondPage.waitFor();
    const secondBox = await secondPage.boundingBox();
    const secondY = secondBox.y + secondBox.height / 2;
    await page.mouse.move(secondBox.x + 1, secondY);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width - 1, secondY, { steps: 16 });
    await menu.waitFor();
    await page.waitForTimeout(pause);
    await watchScroll();
    const beforeDragScroll = await viewport.evaluate(element => element.scrollTop);
    const viewportBox = await viewport.boundingBox();
    await page.mouse.move(secondBox.x + secondBox.width - 1, viewportBox.y + viewportBox.height + 2, { steps: 25 });
    await page.waitForFunction(before => document.querySelector('.pdf-viewport').scrollTop > before.top + before.distance, { top: beforeDragScroll, distance: process.env.PROOF_DIR ? 100 : 30 }, { timeout: 3000 });
    await page.mouse.up();
    await assertScroll();
    if (process.env.PROOF_DIR) await page.waitForTimeout(900);
    await page.close();
  } finally { await browser?.close(); await server.close(); }
});
