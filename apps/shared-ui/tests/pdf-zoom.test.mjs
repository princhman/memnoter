import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { pdfBytes } from './browser/pdf-region-selection-pdf.mjs';

test('reader zoom preserves the reading point, scroll, crop and gesture lifecycle', async () => {
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
    const viewer = page.locator('#viewer');
    const viewport = viewer.locator('.overflow-auto');
    const level = viewer.getByLabel('Zoom level', { exact: true });
    assert.equal(await level.count(), 1, 'Reader exposes its current zoom percentage');
    const zoomIn = viewer.getByRole('button', { name: /^Zoom in/ });
    const zoomOut = viewer.getByRole('button', { name: /^Zoom out/ });
    await viewer.locator('canvas').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#viewer canvas')?.width > 0);
    const waitLevel = value => page.waitForFunction(value => document.querySelector('[aria-label="Zoom level"]')?.textContent === value, value);
    // The same page coordinate must stay at the viewport center through button zoom.
    await viewport.evaluate(element => { element.scrollTop = 850; });
    async function point(fraction = .5) {
      return viewport.evaluate((element, fraction) => {
        const bounds = element.getBoundingClientRect();
        const x = bounds.left + element.clientWidth / 2, y = bounds.top + element.clientHeight * fraction;
        const pages = [...element.querySelectorAll('.pdf-page')];
        const index = pages.findIndex(page => page.getBoundingClientRect().bottom >= y);
        const box = pages[index].getBoundingClientRect();
        return { index, x: (x - box.left) / box.width, y: (y - box.top) / box.height };
      }, fraction);
    }
    function samePoint(before, after) {
      assert.equal(after.index, before.index);
      assert.ok(Math.abs(after.x - before.x) < .005, JSON.stringify({ before, after }));
      assert.ok(Math.abs(after.y - before.y) < .005, JSON.stringify({ before, after }));
    }
    const beforeButton = await point();
    await zoomIn.click(); await waitLevel('110%'); samePoint(beforeButton, await point());
    await zoomOut.click(); await waitLevel('100%'); samePoint(beforeButton, await point());

    async function wheel(delta, count = 1, ctrlKey = true, fraction = .5) {
      return viewport.evaluate((element, { delta, count, ctrlKey, fraction }) => {
        const box = element.getBoundingClientRect();
        const cancelled = [];
        for (let i = 0; i < count; i++) {
          const event = new WheelEvent('wheel', { deltaY: delta / count, ctrlKey, bubbles: true, cancelable: true, clientX: box.left + element.clientWidth / 2, clientY: box.top + element.clientHeight * fraction });
          element.dispatchEvent(event); cancelled.push(event.defaultPrevented);
        }
        return cancelled;
      }, { delta, count, ctrlKey, fraction });
    }
    const beforePinch = await point(.3);
    const canvas = viewer.locator('canvas').first();
    const backingWidth = await canvas.evaluate(element => element.width);
    assert.ok((await wheel(-Math.log(1.5) * 100, 12, true, .3)).every(Boolean));
    // During the gesture only the visual scale changes; PDF canvases settle later.
    assert.equal(await canvas.evaluate(element => element.width), backingWidth);
    await waitLevel('150%'); samePoint(beforePinch, await point(.3));
    assert.ok(await viewer.locator('canvas').count() < 6);

    const scrollBefore = await viewport.evaluate(element => element.scrollTop);
    const bounds = await viewport.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(before => document.querySelector('#viewer .overflow-auto').scrollTop > before + 60, scrollBefore);
    assert.equal(await level.textContent(), '150%');
    assert.deepEqual(await wheel(20, 1, false), [false]);
    assert.equal(await page.locator('#selection-sandbox').evaluate(element => {
      const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -20, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented;
    }), false);

    await wheel(-10000); await waitLevel('300%'); assert.ok(await zoomIn.isDisabled());
    // Horizontal scroll also survives zoom when the page is wider than the pane.
    await viewport.evaluate(element => { element.scrollLeft = 70; });
    const beforeHorizontal = await point();
    await wheel(-Math.log(2.8 / 3) * 100); await waitLevel('280%');
    samePoint(beforeHorizontal, await point());
    await wheel(10000); await waitLevel('25%'); assert.ok(await zoomOut.isDisabled());
    await zoomIn.click(); await waitLevel('35%');
    await wheel(-Math.log(1 / .35) * 100); await waitLevel('100%');

    // Exercise WebKit's event protocol and ignore its overlapping wheel stream.
    await viewport.evaluate(element => {
      const box = element.getBoundingClientRect();
      function gesture(type, scale) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { scale: { value: scale }, clientX: { value: box.left + element.clientWidth / 2 }, clientY: { value: box.top + element.clientHeight / 2 } });
        element.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error('Native gesture was not captured');
      }
      element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true }));
      gesture('gesturestart', 1);
      element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -40, cancelable: true }));
      gesture('gesturechange', 1.5); gesture('gestureend', 1.5);
      element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -40, cancelable: true }));
    });
    await waitLevel('150%');

    // A crop after zoom must use PDF-relative coordinates and the settled bitmap.
    await viewport.evaluate(element => { element.scrollTop = 0; });
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    const selection = viewer.getByLabel('Drag a region on this PDF page').first(); await selection.waitFor();
    const dragBox = await selection.boundingBox();
    await page.mouse.move(dragBox.x + 80, dragBox.y + 80); await page.mouse.down();
    await page.mouse.move(dragBox.x + 180, dragBox.y + 180);
    // Native gesture start cancels captured selection even if its final scale is unchanged.
    const nativeEvent = type => viewport.evaluate((element, type) => {
      const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'scale', { value: 1 }); element.dispatchEvent(event);
    }, type);
    await nativeEvent('gesturestart');
    await selection.waitFor({ state: 'detached' });
    await nativeEvent('gestureend');
    await page.mouse.up();
    assert.equal(await page.locator('#pending').textContent(), 'none');
    await selection.waitFor();
    const cropBox = await selection.boundingBox();
    await page.mouse.move(cropBox.x + cropBox.width * .25, cropBox.y + cropBox.height * .25); await page.mouse.down();
    await page.mouse.move(cropBox.x + cropBox.width * .75, cropBox.y + cropBox.height * .75); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#crop').textContent !== 'null');
    const crop = JSON.parse(await page.locator('#crop').textContent());
    assert.deepEqual({ width: crop.width, height: crop.height, pixel: crop.pixel }, { width: 600, height: 600, pixel: [0, 255, 0, 255] });
    assert.deepEqual(crop.source.region, { x: .25, y: .25, width: .5, height: .5 });

    // Unmount with a pending wheel settle: no detached listener or late zoom save.
    await page.waitForTimeout(260); // Let the native stream's overlap suppression expire.
    await wheel(-10);
    await viewport.evaluate(element => { window.detachedPdfViewport = element; });
    await page.getByRole('button', { name: 'Toggle reader mount', exact: true }).click();
    assert.equal(await page.evaluate(() => {
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        const event = new Event(type, { cancelable: true });
        window.detachedPdfViewport.dispatchEvent(event);
        if (event.defaultPrevented) return true;
      }
      const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true });
      window.detachedPdfViewport.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    await page.waitForTimeout(220);
    await page.getByRole('button', { name: 'Toggle reader mount', exact: true }).click();
    await waitLevel('150%');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
