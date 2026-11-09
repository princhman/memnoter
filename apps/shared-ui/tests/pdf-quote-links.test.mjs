import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
function textPdf() {
  const stream = 'BT /F1 18 Tf 45 280 Td (Select this PDF text across the quoted area) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
test('PDF quote markers navigate by identity, preserve text drag, and offer duplicate uses', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async command => { if (command === 'get_content') return { state: [], updates: [], files: [] }; if (command === 'document_path') return '/links.pdf'; throw new Error(command); } } });`);
    await page.route('**/links.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdf() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-quote-links.html`);
    const viewer = page.locator('#viewer');
    const marker = viewer.getByRole('button', { name: 'Show quote in note', exact: true });
    await marker.waitFor({ timeout: 5000 }); await viewer.locator('.textLayer span').first().waitFor();
    const selected = page.getByLabel('Selected quote');
    const reset = () => page.getByRole('button', { name: 'Reset target', exact: true }).click();
    const expectTarget = id => page.waitForFunction(id => document.querySelector('output').textContent === id, id);
    const bounds = await viewer.locator('.pdf-page').boundingBox();
    const areaClick = () => page.mouse.click(bounds.x + bounds.width * .4, bounds.y + bounds.height * .45);
    await areaClick(); await expectTarget('quote-first'); await reset();
    await marker.focus(); await page.keyboard.press('Enter'); await expectTarget('quote-first'); await reset();
    const text = await viewer.locator('.textLayer span').first().boundingBox();
    await page.mouse.move(text.x + 3, text.y + text.height / 2); await page.mouse.down();
    await page.mouse.move(text.x + Math.min(200, text.width - 3), text.y + text.height / 2, { steps: 15 }); await page.mouse.up();
    assert.ok(await page.evaluate(() => window.getSelection().toString().length > 5), 'PDF text remains selectable');
    assert.equal(await selected.textContent(), ''); await reset();
    await page.mouse.move(bounds.x + 70, bounds.y + 170); await page.mouse.down();
    await page.mouse.move(bounds.x + 140, bounds.y + 170, { steps: 10 }); await page.mouse.up();
    assert.equal(await selected.textContent(), '');
    await page.getByRole('button', { name: 'Add another use', exact: true }).click();
    const multiple = viewer.getByRole('button', { name: 'Show quote in note (2 uses)', exact: true });
    await multiple.waitFor(); await reset(); await areaClick();
    await page.getByRole('menuitem', { name: 'Overview, quote 1', exact: true }).waitFor();
    assert.equal(await selected.textContent(), '');
    await page.getByRole('menuitem', { name: 'Detailed analysis, quote 1', exact: true }).click();
    await expectTarget('quote-second'); await reset();
    await multiple.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Overview, quote 1', exact: true }).focus(); await page.keyboard.press('Enter');
    await expectTarget('quote-first'); await reset();
    await viewer.getByRole('button', { name: 'Select region', exact: true }).click();
    assert.equal(await viewer.getByRole('button', { name: /Show quote in note/ }).count(), 0);
    await viewer.getByRole('button', { name: 'Exit selection', exact: true }).click();
    await page.getByRole('button', { name: 'Stage pending', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.pdf-page > .pointer-events-none > div').length === 2);
    await page.mouse.click(bounds.x + bounds.width * .4, bounds.y + bounds.height * .7);
    assert.equal(await selected.textContent(), '');
    assert.equal(await viewer.getByRole('button', { name: /Show quote in note/ }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
