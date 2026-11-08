import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

import { pdfBytes } from './browser/pdf-region-selection-pdf.mjs';

test('region pointer lifecycle and ready PDF canvas crops', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => { if (command === 'document_path') return '/selection.pdf'; throw new Error(command); } } });`);
    await page.route('**/selection.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-region-selection.html`);
    const sandbox = page.locator('#selection-sandbox');
    const selection = sandbox.getByLabel('Drag a region on this PDF page');
    await selection.waitFor();
    const regions = () => page.locator('#regions').evaluate(element => JSON.parse(element.textContent));
    async function down(x = 10, y = 10) {
      const box = await selection.boundingBox(); await page.mouse.move(box.x + x, box.y + y); await page.mouse.down(); return box;
    }
    let box = await down(150, 70);
    await page.mouse.move(box.x + 240, box.y + 130); await page.mouse.up();
    assert.deepEqual(await regions(), [{ x: .75, y: .7, width: .25, height: .3 }]);
    box = await down(); await page.mouse.move(box.x + 80, box.y + 50); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.locator('#cancelled').textContent(), '1'); assert.equal((await regions()).length, 1);
    // A resize before pointerup invalidates the old coordinate system.
    box = await down(); await page.getByRole('button', { name: 'Resize page', exact: true }).dispatchEvent('click');
    await page.mouse.move(box.x + 100, box.y + 60); await page.mouse.up();
    assert.equal((await regions()).length, 1);
    for (const action of ['Replace page', 'Toggle selection mount']) {
      box = await down(); await page.mouse.move(box.x + 100, box.y + 60);
      await page.getByRole('button', { name: action, exact: true }).dispatchEvent('click'); await page.mouse.up();
      assert.equal((await regions()).length, 1);
    }
    await page.getByRole('button', { name: 'Toggle selection mount', exact: true }).click();
    for (const action of ['cancel', 'capture']) {
      box = await down(); await page.mouse.move(box.x + 100, box.y + 60);
      await selection.evaluate((element, action) => {
        if (action === 'cancel') element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
        else element.releasePointerCapture(1);
      }, action);
      await page.mouse.up(); assert.equal((await regions()).length, 1);
    }
    box = await down(); await page.mouse.move(box.x + 12, box.y + 70); await page.mouse.up();
    assert.equal((await regions()).length, 1);
    box = await down(150, 80); await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.up();
    assert.equal((await regions()).length, 2);

    const viewer = page.locator('#viewer');
    await viewer.locator('canvas').first().waitFor();
    assert.equal(await viewer.getByLabel('Drag a region on this PDF page').count(), 0);
    const contentBounds = await viewer.locator('.pdf-page').first().boundingBox();
    const assertStablePage = async () => assert.deepEqual(await viewer.locator('.pdf-page').first().boundingBox(), contentBounds);
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    await assertStablePage();
    assert.equal(await viewer.getByRole('button', { name: 'Select region', exact: true }).getAttribute('aria-pressed'), 'true');
    await viewer.getByRole('button', { name: 'Exit selection', exact: true }).focus();
    await page.keyboard.press('Enter');
    await assertStablePage();
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    const pageSelection = viewer.getByLabel('Drag a region on this PDF page').first();
    await pageSelection.waitFor();
    // Virtualizing a page away disposes its captured drag; other pages stay usable.
    const firstPage = viewer.locator('.pdf-page').first();
    let firstBounds = await pageSelection.boundingBox();
    await page.mouse.move(firstBounds.x + 40, firstBounds.y + 40); await page.mouse.down();
    await page.mouse.move(firstBounds.x + 160, firstBounds.y + 160);
    await viewer.locator('.overflow-auto').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await firstPage.locator('canvas').waitFor({ state: 'detached' });
    await page.mouse.up();
    assert.equal(await page.locator('#pending').textContent(), 'none');
    assert.ok(await viewer.locator('canvas').count() < 6);
    await viewer.locator('.overflow-auto').evaluate(element => { element.scrollTop = 0; });
    await firstPage.getByLabel('Drag a region on this PDF page').waitFor();
    // Re-rendering at a new zoom must dispose the old drag before its pointerup.
    let bounds = await pageSelection.boundingBox();
    await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
    await page.mouse.move(bounds.x + 160, bounds.y + 160);
    await viewer.getByRole('button', { name: 'Zoom in (100%)', exact: true }).dispatchEvent('click');
    await page.mouse.up();
    assert.equal(await page.locator('#pending').textContent(), 'none');
    await pageSelection.waitFor();
    await viewer.getByRole('button', { name: 'Zoom out (110%)', exact: true }).click();
    await pageSelection.waitFor();
    async function dragCrop() {
      const bounds = await pageSelection.boundingBox();
      await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .25); await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * .75, bounds.y + bounds.height * .75); await page.mouse.up();
    }
    await assertStablePage();
    // Hold canvas encoding so the preparing state is observable.
    await page.evaluate(() => {
      window.originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { window.finishCrop = () => window.originalToBlob.call(this, callback, ...args); };
    });
    await dragCrop();
    await viewer.getByRole('status').filter({ hasText: 'Preparing quote' }).waitFor();
    await assertStablePage();
    await page.evaluate(() => { window.finishCrop(); HTMLCanvasElement.prototype.toBlob = window.originalToBlob; });
    await page.waitForFunction(() => document.querySelector('#crop').textContent !== 'null');
    await assertStablePage();
    const crop = JSON.parse(await page.locator('#crop').textContent());
    assert.deepEqual({ width: crop.width, height: crop.height, pixel: crop.pixel }, { width: 400, height: 400, pixel: [0, 255, 0, 255] });
    assert.deepEqual(crop.source, { documentId: 'selection-pdf', name: 'Selection.pdf', page: 1, region: { x: .25, y: .25, width: .5, height: .5 } });
    // Encoding failure must leave selection recoverable and no draft behind.
    await page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    await page.evaluate(() => { window.originalToBlob = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null); }; });
    await dragCrop(); await viewer.getByRole('alert').filter({ hasText: 'Could not create quote PNG' }).waitFor();
    assert.equal(await page.locator('#pending').textContent(), 'none');
    await assertStablePage();
    await pageSelection.waitFor();
    // A second pending quote arriving while encoding must not be overwritten.
    await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function(callback, ...args) { window.finishCrop = () => window.originalToBlob.call(this, callback, ...args); }; });
    await dragCrop();
    await page.getByRole('button', { name: 'Stage other quote', exact: true }).click();
    await page.evaluate(() => window.finishCrop());
    await viewer.getByRole('alert').filter({ hasText: 'Another quote is waiting' }).waitFor();
    assert.equal(await page.locator('#pending').textContent(), 'Existing.pdf');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
