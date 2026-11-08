import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

function pdfBytes() {
  const stream = 'BT /F1 18 Tf 20 180 Td (Selectable PDF text across the page) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('files resize previews a fixed layout, commits on release, and cleans up every exit', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => {
      if (command === 'list_documents') return [{ id: 'resize-pdf', moduleId: 'resize-module', moduleName: 'Resize', name: 'Resize.pdf', size: 1000, pageCount: 1, createdAt: 0, available: true }];
      if (command === 'document_path') return '/resize.pdf';
      throw new Error(command);
    } } }); localStorage.setItem('pdf-pane:resize-module', JSON.stringify({ open: true, active: 'resize-pdf', width: 500 }));
      window.paneWrites = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'pdf-pane:resize-module') window.paneWrites++;
        return setItem.call(this, key, value);
      };`);
    await page.route('**/resize.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-pane-resize.html`);
    const separator = page.getByRole('separator', { name: 'Resize files panel' });
    const files = page.getByRole('complementary', { name: 'Files', exact: true });
    await page.locator('.textLayer span').first().waitFor();
    const selection = () => page.evaluate(() => {
      const selection = window.getSelection();
      return { text: selection.toString(), anchor: selection.anchorOffset, focus: selection.focusOffset,
        anchorText: selection.anchorNode?.textContent, focusText: selection.focusNode?.textContent };
    });
    const guide = separator.locator('[aria-hidden="true"]');
    const writes = () => page.evaluate(() => window.paneWrites);
    const geometry = () => page.evaluate(() => {
      const rect = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        document: rect(document.documentElement),
        note: rect(document.querySelector('.app-scroll-container')),
        files: rect(document.querySelector('aside[aria-label="Files"]')),
        viewport: rect(document.querySelector('aside .overflow-auto')),
        page: rect(document.querySelector('.pdf-page')),
        canvas: rect(document.querySelector('.pdf-page canvas')),
        rootWidth: document.documentElement.style.getPropertyValue('--pdf-pane-width'),
      };
    });
    const storedWidth = () => page.evaluate(() => JSON.parse(localStorage.getItem('pdf-pane:resize-module')).width);
    async function start() {
      const bounds = await separator.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 200); await page.mouse.down();
      return bounds;
    }
    await page.locator('.tiptap').evaluate(element => {
      element.focus(); const text = element.querySelector('p').firstChild;
      window.getSelection().setBaseAndExtent(text, 22, text, 9);
    });
    const noteSelection = await selection();
    const initial = (await files.boundingBox()).width;
    await files.evaluate(element => {
      window.observedPaneWidths = [];
      window.paneObserver = new ResizeObserver(entries => window.observedPaneWidths.push(entries[0].contentRect.width));
      window.paneObserver.observe(element);
    });
    await page.waitForFunction(() => window.observedPaneWidths.length === 1);
    const fixed = await geometry();
    const initialWrites = await writes();
    let bounds = await start();
    assert.deepEqual(await selection(), noteSelection, 'starting resize preserves the note selection');
    assert.equal(await page.locator('.textLayer span').first().evaluate(element => getComputedStyle(element).userSelect), 'none', 'explicit PDF text selection is disabled during resize');
    for (const distance of [20, 55, 110]) {
      await page.mouse.move(bounds.x - distance, bounds.y + 220);
      assert.deepEqual(await geometry(), fixed, 'document, note, PDF viewport, page and canvas stay fixed during drag');
      const preview = await guide.boundingBox();
      assert.ok(Math.abs(preview.x - (bounds.x - distance - bounds.width)) < 1, 'preview tracks the final divider boundary');
    }
    assert.equal(await writes(), initialWrites, 'pointer moves do not persist state');
    assert.equal(await separator.getAttribute('aria-valuenow'), '500');
    assert.equal((await files.boundingBox()).width, initial, 'pane geometry stays fixed until release');
    assert.equal(await storedWidth(), 500, 'dragging does not publish pane state per pointer move');
    const pdf = await page.locator('.pdf-page').boundingBox();
    await page.mouse.move(pdf.x + 120, pdf.y + 100);
    assert.deepEqual(await geometry(), fixed);
    const finalBoundary = await guide.boundingBox();
    await page.mouse.up();
    assert.equal(await writes(), initialWrites + 1, 'release persists exactly once');
    assert.equal(await guide.isVisible(), false);
    assert.ok(Math.abs((await files.boundingBox()).x - finalBoundary.x - finalBoundary.width) < 1, 'release applies the previewed boundary');
    const committedWidth = (await files.boundingBox()).width;
    assert.notEqual(committedWidth, initial);
    await page.waitForFunction(() => window.observedPaneWidths.length >= 2);
    assert.deepEqual(await page.evaluate(() => {
      window.paneObserver.disconnect();
      return window.observedPaneWidths;
    }), [initial, committedWidth], 'release produces one pane layout change');
    assert.deepEqual(await selection(), noteSelection);
    assert.equal(await page.locator('#pending').textContent(), 'none');
    assert.equal(await page.locator('.textLayer span').first().evaluate(element => getComputedStyle(element).userSelect), 'text');
    assert.notEqual(await storedWidth(), 500);
    await page.getByRole('button', { name: 'Select region', exact: true }).click();
    bounds = await start();
    const region = await page.getByLabel('Drag a region on this PDF page').boundingBox();
    await page.mouse.move(region.x + 150, region.y + 140, { steps: 5 }); await page.mouse.up();
    assert.equal(await page.locator('#pending').textContent(), 'none', 'resize must not create a region quote');
    assert.deepEqual(await selection(), noteSelection);
    await page.evaluate(() => {
      document.body.style.setProperty('user-select', 'text', 'important');
      document.body.style.setProperty('-webkit-user-select', 'text', 'important');
      document.body.style.setProperty('cursor', 'help', 'important');
    });
    const before = await page.evaluate(() => document.body.style.cssText);
    for (const exit of ['cancel', 'capture', 'close', 'unmount']) {
      const original = await storedWidth();
      const originalWrites = await writes();
      const fixed = await geometry();
      const selected = await selection();
      bounds = await start();
      await page.mouse.move(bounds.x - 65, bounds.y + 200);
      assert.deepEqual(await geometry(), fixed);
      assert.equal(await guide.isVisible(), true);
      if (exit === 'unmount') await page.getByRole('button', { name: 'Toggle pane mount' }).dispatchEvent('click');
      else if (exit === 'close') await page.getByRole('button', { name: 'Close', exact: true }).dispatchEvent('click');
      else await separator.evaluate((element, exit) => {
        if (exit === 'cancel') element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
        else element.releasePointerCapture(1);
      }, exit);
      await page.mouse.up();
      if (exit !== 'unmount') assert.deepEqual(await selection(), selected);
      assert.equal(await storedWidth(), original, `${exit} abandons the pending width`);
      assert.equal(await writes(), originalWrites + (exit === 'close' ? 1 : 0), `${exit} does not persist a resize`);
      if (exit === 'close') {
        await page.getByRole('button', { name: 'Open pane', exact: true }).click();
        await page.locator('.textLayer span').first().waitFor();
      }
      if (exit !== 'unmount') {
        assert.equal(await guide.isVisible(), false);
        assert.deepEqual(await geometry(), fixed);
      }
      assert.equal(await page.locator('#outside').evaluate(element => getComputedStyle(element).userSelect), 'text');
      assert.equal(await page.locator('#outside').evaluate(element => getComputedStyle(element).cursor), 'help');
      assert.equal(await page.evaluate(() => document.body.style.cssText), before);
      if (exit === 'unmount') {
        await page.getByRole('button', { name: 'Toggle pane mount' }).click();
        await separator.waitFor();
        await page.locator('.textLayer span').first().waitFor();
      }
      await page.locator('#outside').selectText();
      assert.equal((await selection()).text, 'Text remains selectable after resize cleanup.');
    }
    // Real touch input uses the same capture lifecycle without native panning.
    const touchWidth = await storedWidth();
    const touch = await page.context().newCDPSession(page);
    bounds = await separator.boundingBox();
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 180 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    const touchGeometry = await geometry();
    const touchWrites = await writes();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 80, y: point.y }] });
    assert.deepEqual(await geometry(), touchGeometry, 'touch keeps both panes fixed too');
    assert.equal(await writes(), touchWrites);
    assert.equal(await guide.isVisible(), true);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await writes(), touchWrites + 1);
    assert.equal(await guide.isVisible(), false);
    assert.ok((await storedWidth()) >= touchWidth + 79, 'touch dragging changes the panel width');
    assert.equal(await page.locator('#outside').evaluate(element => getComputedStyle(element).cursor), 'help');
    // Touch cancellation must discard the preview, including implicit capture loss.
    bounds = await separator.boundingBox();
    const cancelPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + 180 };
    const beforeCancel = await geometry();
    const cancelWidth = await storedWidth();
    const cancelWrites = await writes();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [cancelPoint] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cancelPoint.x - 60, y: cancelPoint.y }] });
    assert.equal(await guide.isVisible(), true);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.equal(await guide.isVisible(), false);
    assert.deepEqual(await geometry(), beforeCancel);
    assert.equal(await storedWidth(), cancelWidth);
    assert.equal(await writes(), cancelWrites);
    assert.equal(await page.locator('#outside').evaluate(element => getComputedStyle(element).cursor), 'help');
    for (const [x, expected] of [[1, 1000], [1399, 320]]) {
      await start(); await page.mouse.move(x, 250);
      const preview = await guide.boundingBox();
      await page.mouse.up();
      assert.ok(Math.abs((await files.boundingBox()).x - preview.x - preview.width) < 1, 'preview respects viewport and pane limits');
      assert.equal(await storedWidth(), expected);
    }
    assert.equal(await separator.getAttribute('aria-valuemin'), '320');
    assert.equal(await separator.getAttribute('aria-valuemax'), '1000');
    const width = await storedWidth();
    await separator.focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await storedWidth(), Math.min(1000, width + 20));
    assert.equal((await files.boundingBox()).width, Math.min(1000, width + 20));
    assert.equal(await separator.getAttribute('aria-valuenow'), String(Math.min(1000, width + 20)));
    await page.keyboard.press('ArrowRight');
    assert.equal(await storedWidth(), Math.min(1000, width + 20) - 20);
    for (const input of [{ pointerId: 11, button: 2, isPrimary: true }, { pointerId: 12, button: 0, isPrimary: false }]) {
      await separator.dispatchEvent('pointerdown', input);
      assert.equal(await page.locator('#outside').evaluate(element => getComputedStyle(element).cursor), 'help');
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
