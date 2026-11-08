import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { pdfBytes } from './browser/pdf-region-selection-pdf.mjs';
test('PDF shortcuts scope to the note and reader, cancel drags, preserve views, and clean up', async () => {
  const server = await browserHarness(import.meta.url).createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => { if (command === 'get_content') return { state: [], updates: [], files: [] };
      if (command === 'list_documents') return [{ id: 'shortcut-pdf', moduleId: 'module', moduleName: 'Module', name: 'Shortcuts.pdf', size: 1000, pageCount: 6, createdAt: 0, available: true }];
      if (command === 'document_path') return '/shortcuts.pdf'; throw new Error(command);
    } } }); localStorage.setItem('pdf-pane:module', JSON.stringify({ open: true, active: 'shortcut-pdf', width: 500 }));`);
    await page.route('**/shortcuts.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-shortcuts.html`);
    const select = page.getByRole('button', { name: 'Select region', exact: true });
    const region = page.getByLabel('Drag a region on this PDF page').first();
    const editor = page.locator('.ProseMirror');
    const files = page.getByRole('complementary', { name: 'Files', exact: true });
    const ready = () => page.waitForFunction(() => document.querySelector('button[aria-label="Select region"]')?.disabled === false);
    await ready(); await editor.click(); await page.keyboard.press('Control+Shift+x'); await region.waitFor();
    const box = await region.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 160);
    await page.keyboard.press('Control+Shift+x'); await page.mouse.up();
    assert.equal(await select.getAttribute('aria-pressed'), 'false'); assert.equal(await page.locator('#pending').textContent(), 'none');
    for (const target of [page.getByLabel('Unrelated input'), page.getByLabel('Find in note'), page.getByRole('button', { name: 'Dialog action' }), page.getByRole('button', { name: 'Menu action' }), page.getByLabel('Page number')]) {
      await target.focus(); await page.keyboard.press('Control+Shift+x'); await page.keyboard.press('Control+Shift+d');
      assert.equal(await select.getAttribute('aria-pressed'), 'false'); assert.equal(await files.count(), 1);
    }
    await editor.focus();
    for (const extra of [{ repeat: true }, { isComposing: true }]) {
      await editor.dispatchEvent('keydown', { key: 'x', code: 'KeyX', ctrlKey: true, shiftKey: true, ...extra });
      assert.equal(await select.getAttribute('aria-pressed'), 'false');
    }
    await page.keyboard.press('Control+Shift+d'); await files.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+Shift+d'); await select.waitFor();
    await page.getByRole('button', { name: 'Reader', exact: true }).click(); await ready();
    assert.ok((await page.locator('#commands').textContent()).includes('pdf.open-beside'));
    await page.getByLabel('Page number').fill('3'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Zoom in (100%)', exact: true }).click();
    await page.keyboard.press('Control+Shift+o'); await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Page number"]')?.value === '3');
    assert.equal(await page.getByLabel('Zoom level').textContent(), '110%');
    await page.getByRole('button', { name: 'Reader', exact: true }).click(); await ready(); await page.getByLabel('Page number').fill('1'); await page.keyboard.press('Enter'); await select.click(); await region.waitFor();
    const crop = await region.boundingBox();
    await page.mouse.move(crop.x + 30, crop.y + 30); await page.mouse.down(); await page.mouse.move(crop.x + 180, crop.y + 180); await page.mouse.up();
    await page.getByRole('button', { name: 'Insert at cursor', exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await page.locator('#pending').textContent()), { section: false, status: 'draft' });
    await page.keyboard.press('Control+Shift+x'); assert.equal(await select.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Control+Enter'); await editor.waitFor();
    await page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    await page.getByRole('button', { name: 'Away', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#commands').textContent.includes('pdf.'));
    const pane = await page.evaluate(() => localStorage.getItem('pdf-pane:module'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+Shift+d'); await page.keyboard.press('Control+Shift+x'); await page.keyboard.press('Control+Shift+o');
    assert.equal(await page.evaluate(() => localStorage.getItem('pdf-pane:module')), pane);
    await page.getByRole('button', { name: 'Note', exact: true }).click(); await editor.waitFor(); await editor.focus();
    await page.keyboard.press('Meta+Shift+d'); await files.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
