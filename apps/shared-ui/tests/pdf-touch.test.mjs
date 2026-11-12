import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { pdfBytes } from './browser/pdf-region-selection-pdf.mjs';

// CDP exercises real touch/pointer cancellation and scrolling, which synthetic
// WebKit GestureEvents cannot cover.
test('PDF touch pinch/pan preserves the reading point and cancels a captured crop', async () => {
  const server = await browserHarness(import.meta.url).createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ hasTouch: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", deviceScaleFactor: 2, viewport: { width: 600, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => {
      if (command === 'get_content') return { state: [], updates: [], files: [] };
      if (command === 'document_path') return '/selection.pdf';
      if (command === 'load_annotations') return { state: null, revision: 0, generation: 'touch-test' };
      throw new Error(command);
    } } });`);
    await page.route('**/selection.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-region-selection.html`);
    const viewer = page.locator('#viewer'), viewport = viewer.locator('.pdf-viewport');
    const level = viewer.getByLabel('Zoom level', { exact: true });
    const zoomIn = viewer.getByRole('button', { name: /^Zoom in/ });
    await page.waitForFunction(() => document.querySelector('#viewer canvas')?.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255);
    for (const control of [zoomIn, viewer.getByRole('button', { name: 'Select region', exact: true }), viewer.getByLabel('Page number')]) {
      const box = await control.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `44px touch target: ${JSON.stringify(box)}`);
    }
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 })) });
    const box = await viewport.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await touch('touchStart', [[0, cx, cy + 70]]);
    for (let dy = 50; dy >= -70; dy -= 20) await touch('touchMove', [[0, cx, cy + dy]]);
    await touch('touchEnd');
    await page.waitForFunction(() => document.querySelector('#viewer .pdf-viewport').scrollTop > 50);
    assert.equal(await level.textContent(), '100%', 'one-finger scrolling does not zoom');
    for (const value of ['110%', '120%', '130%', '140%', '150%']) {
      await zoomIn.click();
      await page.waitForFunction(value => document.querySelector('[aria-label="Zoom level"]').textContent === value, value);
    }
    await viewport.evaluate(async element => {
      element.scrollTop = 1000;
      // The preceding native swipe can still be decelerating. Capture the
      // pinch reference only after scrolling settles, as a reader would.
      let last = element.scrollTop, stable = 0;
      while (stable < 5) {
        await new Promise(requestAnimationFrame);
        const next = element.scrollTop;
        stable = next === last ? stable + 1 : 0;
        last = next;
      }
    });
    const point = async (x = cx, y = cy) => viewport.evaluate((element, { x, y }) => {
      const page = [...element.querySelectorAll('[data-pdf-page]')].find(page => page.getBoundingClientRect().bottom >= y);
      const box = page.getBoundingClientRect();
      return { page: page.dataset.pdfPage, x: (x - box.left) / box.width, y: (y - box.top) / box.height };
    }, { x, y });
    const samePoint = (before, after) => {
      assert.equal(after.page, before.page);
      assert.ok(Math.abs(after.x - before.x) < .006 && Math.abs(after.y - before.y) < .006, JSON.stringify({ before, after }));
    };
    const before = await point();
    const backingWidth = await viewer.locator(`[data-pdf-page="${before.page}"] canvas`).evaluate(canvas => canvas.width);
    await touch('touchStart', [[0, cx - 50, cy], [1, cx + 50, cy]]);
    await touch('touchMove', [[0, cx - 75 + 30, cy - 25], [1, cx + 75 + 30, cy - 25]]);
    await page.waitForTimeout(100);
    samePoint(before, await point(cx + 30, cy - 25));
    assert.equal(await level.textContent(), '150%', 'touch moves only preview the bitmap');
    assert.equal(await viewer.locator(`[data-pdf-page="${before.page}"] canvas`).evaluate(canvas => canvas.width), backingWidth);
    await viewport.evaluate(element => {
      for (const type of ['gesturestart', 'gesturechange']) {
        const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'scale', { value: 3 }); element.dispatchEvent(event);
      }
      element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true }));
    });
    await touch('touchEnd');
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"]').textContent === '225%');
    samePoint(before, await point(cx + 30, cy - 25));
    await page.waitForTimeout(280);
    await viewport.evaluate(element => {
      const end = new Event('gestureend', { cancelable: true }); Object.defineProperty(end, 'scale', { value: 3 }); element.dispatchEvent(end);
    });
    assert.equal(await level.textContent(), '225%', 'late end of an overlapping native stream cannot replay a stale scale');
    assert.equal(await page.evaluate(() => window.visualViewport.scale), 1, 'browser zoom stays unchanged');
    const beforePan = await point();
    await touch('touchStart', [[0, cx - 50, cy], [1, cx + 50, cy]]);
    await touch('touchMove', [[0, cx - 50 - 15, cy + 20], [1, cx + 50 - 15, cy + 20]]);
    await touch('touchEnd');
    samePoint(beforePan, await point(cx - 15, cy + 20));
    assert.equal(await level.textContent(), '225%');
    await touch('touchStart', [[0, cx - 50, cy], [1, cx + 50, cy]]);
    await touch('touchMove', [[0, cx - 60, cy], [1, cx + 60, cy]]);
    await touch('touchCancel');
    await page.waitForTimeout(280);
    assert.equal(await level.textContent(), '225%', 'cancelled pinch discards its preview');
    await viewport.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    const selection = viewer.getByLabel('Drag a region on this PDF page').first(); await selection.waitFor();
    const regionBox = await selection.boundingBox();
    const x = regionBox.x + 100, y = regionBox.y + 100;
    await touch('touchStart', [[0, x, y]]);
    await touch('touchMove', [[0, x + 30, y + 30]]);
    await touch('touchStart', [[0, x + 30, y + 30], [1, x + 130, y + 30]]);
    await selection.waitFor({ state: 'detached' });
    await touch('touchMove', [[0, x + 25, y + 30], [1, x + 135, y + 30]]);
    await touch('touchEnd');
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"]').textContent === '248%', null, { timeout: 5000 });
    assert.equal(await page.locator('#pending').textContent(), 'none', 'second finger cancels rather than quoting');
    await selection.waitFor();
    const finalBox = await selection.boundingBox();
    const a = { x: finalBox.x + finalBox.width * .3, y: finalBox.y + finalBox.height * .3 };
    const b = { x: finalBox.x + finalBox.width * .4, y: finalBox.y + finalBox.height * .4 };
    await touch('touchStart', [[0, a.x, a.y]]);
    await touch('touchMove', [[0, b.x, b.y]]);
    await touch('touchEnd');
    await page.waitForFunction(() => document.querySelector('#crop').textContent !== 'null');
    const crop = JSON.parse(await page.locator('#crop').textContent());
    assert.ok(Math.abs(crop.source.region.x - .3) < .005 && Math.abs(crop.source.region.width - .1) < .005);
    assert.deepEqual(crop.pixel, [0, 255, 0, 255]);
    await page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    await selection.waitFor();
    const penBox = await selection.boundingBox();
    for (const [type, fraction, buttons] of [['mousePressed', .28, 1], ['mouseMoved', .36, 1], ['mouseReleased', .36, 0]]) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: penBox.x + penBox.width * fraction, y: penBox.y + penBox.height * fraction, button: 'left', buttons, pointerType: 'pen' });
    }
    await page.waitForFunction(() => document.querySelector('#crop').textContent !== 'null');
    const penCrop = JSON.parse(await page.locator('#crop').textContent());
    assert.ok(Math.abs(penCrop.source.region.x - .28) < .005 && Math.abs(penCrop.source.region.width - .08) < .005, 'pen input selects the same PDF coordinates');
    assert.deepEqual(penCrop.pixel, [0, 255, 0, 255]);
    await page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    await touch('touchStart', [[0, cx - 50, cy], [1, cx + 50, cy]]);
    await touch('touchMove', [[0, cx - 60, cy], [1, cx + 60, cy]]);
    await page.getByRole('button', { name: 'Toggle reader mount', exact: true }).click();
    await touch('touchEnd');
    await page.waitForTimeout(280);
    await page.getByRole('button', { name: 'Toggle reader mount', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"]').textContent === '248%');
    await page.waitForFunction(() => document.querySelector('#viewer canvas')?.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255);
    // Explicit zoom controls may interrupt a gesture (for example via an
    // attached keyboard). Remaining fingers must not replay the old scale.
    await touch('touchStart', [[0, cx - 50, cy], [1, cx + 50, cy]]);
    await touch('touchMove', [[0, cx - 55, cy], [1, cx + 55, cy]]);
    await viewer.getByRole('button', { name: /^Zoom out/ }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"]').textContent === '262%');
    await touch('touchMove', [[0, cx - 60, cy], [1, cx + 60, cy]]);
    await touch('touchEnd');
    await page.waitForTimeout(280);
    assert.equal(await level.textContent(), '262%', 'interrupted touch does not override the explicit zoom');
    await viewer.evaluate(element => { element.style.width = '320px'; });
    const tools = viewer.locator('.pdf-reader-controls');
    for (const name of [/^Zoom out/, /^Zoom in/, 'Select region', 'Annotate area']) {
      const control = viewer.getByRole('button', { name, exact: typeof name === 'string' });
      await control.scrollIntoViewIfNeeded();
      const area = await tools.boundingBox(), button = await control.boundingBox();
      assert.ok(button.width >= 44 && button.height >= 44);
      assert.ok(button.x >= area.x - 1 && button.x + button.width <= area.x + area.width + 1, 'all controls remain reachable in a 320px pane');
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
