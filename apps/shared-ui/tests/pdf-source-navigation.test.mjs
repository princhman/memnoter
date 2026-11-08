import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

// Exercises real caption clicks, the router and pane store. A custom event without
// a listener, a dropped page search, or a late lookup opening the wrong screen fails here.
test('source navigation and section picker preserve destinations and retained drafts', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const setup = () => {
      window.sourceModule = 'module-one';
      window.holdDocuments = false;
      window.installTestBridge({ tauri: { invoke: async command => {
        if (command !== 'list_documents') throw new Error(`Unexpected command: ${command}`);
        if (window.holdDocuments) await new Promise(resolve => window.releaseDocuments = resolve);
        return [{ id: 'pdf-one', moduleId: window.sourceModule, name: 'Lecture.pdf', pageCount: 20, available: true }];
      } } });
    };
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})();`);
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-source-navigation.html`);
    const source = page.getByRole('button', { name: 'Lecture.pdf, page 7', exact: true });
    await source.click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).pane.active === 'pdf-one');
    const state = JSON.parse(await page.locator('output').textContent());
    assert.equal(state.pane.open, true);
    assert.equal(state.request.page, 7);
    assert.equal(state.request.id, 'pdf-one');
    assert.equal(await page.getByText('Invalid.pdf', { exact: false }).count(), 0);
    assert.equal(await page.getByText('/private/', { exact: false }).count(), 0);
    await page.getByRole('button', { name: 'Deleted.pdf, page 7' }).click();
    await page.getByRole('status').filter({ hasText: 'Source PDF is no longer available' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Deleted.pdf, page 7' }).count(), 1);
    await page.evaluate(() => window.sourceModule = 'module-two');
    await source.click();
    await page.waitForFunction(() => window.navigationTest.router.state.location.pathname === '/files/pdf-one');
    assert.equal(await page.evaluate(() => window.navigationTest.router.state.location.search.page), 7);
    // Source links also work when a caption is rendered outside a module page.
    await source.click();
    await page.waitForFunction(() => !document.querySelector('button').disabled);
    assert.equal(await page.evaluate(() => window.navigationTest.router.state.location.search.page), 7);
    const lastRequest = await page.evaluate(() => window.navigationTest.pdfPageRequest.state);
    assert.equal(lastRequest.page, 7);
    assert.ok(lastRequest.serial > state.request.serial);
    // Lookup started on one screen must not navigate after the user leaves it.
    await page.evaluate(() => { window.holdDocuments = true; window.releaseDocuments = null; });
    await source.click();
    await page.waitForFunction(() => window.releaseDocuments);
    await page.evaluate(async () => {
      await window.navigationTest.router.navigate({ to: '/$moduleId', params: { moduleId: 'module-three' } });
      window.releaseDocuments();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await page.waitForFunction(() => document.querySelector('output'));
    assert.equal(await page.evaluate(() => window.navigationTest.router.state.location.pathname), '/module-three');
    assert.equal(JSON.parse(await page.locator('output').textContent()).request.serial, lastRequest.serial);
    // Exercise the controls' destination contract; persistence is covered by pdf-quotes.
    await page.evaluate(() => window.navigationTest.router.navigate({ to: '/picker' }));
    await page.waitForFunction(() => window.pickerTest);
    const note = page.locator('.tiptap');
    const noteBounds = await note.boundingBox();
    const assertStableNote = async () => assert.deepEqual(await note.boundingBox(), noteBounds);
    await page.evaluate(() => window.pickerTest.draft());
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await assertStableNote();
    assert.equal(await page.evaluate(() => window.pickerTest.pendingPdfQuote.state.status), 'draft');
    await page.evaluate(async () => { await window.pickerTest.unrelatedFailure(); window.pickerTest.control.rejectAdmission = true; });
    await page.getByRole('button', { name: 'Choose section', exact: true }).click();
    await page.getByRole('button', { name: 'End of note', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Saving is temporarily unavailable' }).waitFor();
    await assertStableNote();
    assert.equal(await page.evaluate(() => window.pickerTest.pendingPdfQuote.state.status), 'draft');
    await page.evaluate(() => window.pickerTest.control.rejectAdmission = false);
    await page.getByRole('button', { name: 'Choose section', exact: true }).click();
    await page.evaluate(() => window.pickerTest.editor.commands.insertContentAt(1, 'Renamed '));
    await page.getByRole('button', { name: 'Renamed First section', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), [{ headingId: 'stable-section' }]);
    await page.getByRole('status').filter({ hasText: 'Saving quote' }).waitFor();
    await assertStableNote();
    await page.setViewportSize({ width: 280, height: 800 });
    const narrowNoteBounds = await note.boundingBox();
    await page.evaluate(() => window.pickerTest.pendingPdfQuote.setState(current => ({ ...current, status: 'error', error: 'ConnectionUnavailable'.repeat(80) })));
    const retry = page.getByRole('button', { name: 'Retry images', exact: true });
    await retry.waitFor();
    await retry.focus();
    assert.equal(await retry.evaluate(element => element === document.activeElement), true);
    const controlBounds = await page.getByRole('status').filter({ has: retry }).boundingBox();
    const headerBounds = await page.locator('header').boundingBox();
    assert.ok(controlBounds.x >= 0 && controlBounds.x + controlBounds.width <= 280);
    assert.ok(controlBounds.y >= headerBounds.y + headerBounds.height);
    assert.deepEqual(await note.boundingBox(), narrowNoteBounds);
    await page.evaluate(() => window.pickerTest.pendingPdfQuote.setState(() => null));
    assert.deepEqual(await note.boundingBox(), narrowNoteBounds);
    await page.evaluate(() => {
      window.pickerTest.draft();
      window.pickerTest.pendingPdfQuote.setState(current => ({ ...current, section: false }));
      window.pickerTest.editor.commands.setTextSelection(3);
    });
    const cursor = await page.evaluate(() => window.pickerTest.editor.state.selection.from);
    await page.getByRole('button', { name: 'Quote at cursor', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls.at(-1)), { position: cursor });
    await page.evaluate(() => {
      window.pickerTest.draft();
      window.pickerTest.pendingPdfQuote.setState(current => ({ ...current, section: false }));
    });
    await page.getByRole('button', { name: 'Discard', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.pickerTest.pendingPdfQuote.state), null);
    await page.evaluate(() => window.pickerTest.setModuleId('module-other'));
    await page.waitForFunction(() => window.pickerTest.calls.length === 0);
    await page.evaluate(() => window.pickerTest.draft());
    assert.equal(await page.getByRole('button', { name: 'Choose section', exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
