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
    const insertQuote = page.getByRole('button', { name: 'Insert at cursor', exact: true });
    await insertQuote.waitFor();
    const strip = page.getByRole('group', { name: 'Image quote actions' });
    assert.equal(await strip.getByRole('button').count(), 3);
    await insertQuote.hover();
    await page.getByRole('tooltip').filter({ hasText: 'Insert at cursor' }).waitFor();
    assert.match(await page.getByRole('tooltip').textContent(), /Ctrl\+Enter|⌘↵/);
    const primaryColor = await insertQuote.evaluate(element => getComputedStyle(element).backgroundColor);
    for (const name of ['Choose section', 'Dismiss quote']) {
      assert.notEqual(await strip.getByRole('button', { name, exact: true }).evaluate(element => getComputedStyle(element).backgroundColor), primaryColor, 'secondary controls stay visually quiet');
    }
    assert.equal(await page.getByText('Image quote ready', { exact: true }).count(), 0);
    const assertCompactStrip = async () => {
      const bounds = await strip.boundingBox();
      const buttons = await strip.getByRole('button').all();
      const buttonBounds = await Promise.all(buttons.map(button => button.boundingBox()));
      assert.ok(bounds.height <= 44, 'ready strip stays one compact row');
      assert.ok(buttonBounds.every(button => button.y === buttonBounds[0].y), 'actions do not wrap');
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width);
    };
    await assertCompactStrip();
    await assertStableNote();
    assert.equal(await strip.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(13, bounds.y + bounds.height / 2)?.tagName;
    }), 'MAIN', 'floating anchor passes pointer events through outside the card');
    await page.getByRole('textbox', { name: 'Other field' }).focus();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), [], 'the quote shortcut leaves other editable fields alone');
    // Fullscreen-origin drafts use the editor's restored/current cursor too.
    await page.evaluate(() => {
      window.pickerTest.editor.commands.setTextSelection({ from: 3, to: 6 });
      window.pickerTest.editor.view.focus();
    });
    await insertQuote.click();
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), [{ position: 3 }]);
    assert.equal(await page.getByRole('dialog').count(), 0, 'cursor insertion needs no destination dialog');
    assert.deepEqual(await page.evaluate(() => {
      const { from, to } = window.pickerTest.editor.state.selection;
      return { from, to };
    }), { from: 3, to: 6 }, 'clicking quote controls preserves the editor selection');
    await page.evaluate(() => window.pickerTest.editor.commands.setTextSelection(9));
    await page.locator('header').click();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), [{ position: 3 }], 'a pending handoff cannot retarget or submit twice');
    await page.evaluate(() => {
      window.pickerTest.control.finish();
      window.pickerTest.calls.length = 0;
      window.pickerTest.draft();
    });
    await page.getByRole('button', { name: 'Choose section', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), [], 'insert shortcut does not submit behind an open picker');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Choose section');
    await assertStableNote();
    assert.equal(await page.evaluate(() => window.pickerTest.pendingPdfQuote.state.status), 'draft');
    await page.getByRole('button', { name: 'Choose section', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Choose section');
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
    assert.equal(await page.getByRole('button', { name: 'Saving quote…', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Dismiss quote', exact: true }).isDisabled(), true);
    await assertStableNote();
    await page.setViewportSize({ width: 280, height: 800 });
    const narrowNoteBounds = await note.boundingBox();
    await page.evaluate(() => window.pickerTest.pendingPdfQuote.setState(current => ({ ...current, status: 'error', error: 'ConnectionUnavailable'.repeat(80) })));
    const retry = page.getByRole('button', { name: 'Retry images', exact: true });
    await retry.waitFor();
    assert.equal(await insertQuote.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Choose section', exact: true }).isDisabled(), true);
    await retry.focus();
    assert.equal(await retry.evaluate(element => element === document.activeElement), true);
    const controlBounds = await page.getByRole('status').filter({ has: retry }).boundingBox();
    const headerBounds = await page.locator('header').boundingBox();
    assert.ok(controlBounds.x >= 0 && controlBounds.x + controlBounds.width <= 280);
    assert.ok(controlBounds.y >= headerBounds.y + headerBounds.height);
    assert.deepEqual(await note.boundingBox(), narrowNoteBounds);
    await page.evaluate(() => window.pickerTest.pendingPdfQuote.setState(() => null));
    assert.deepEqual(await note.boundingBox(), narrowNoteBounds);
    for (const [section, shortcut] of [[true, 'Meta+Enter'], [false, 'Control+Enter']]) {
      await page.evaluate(section => {
        window.pickerTest.draft();
        window.pickerTest.pendingPdfQuote.setState(current => ({ ...current, section, source: { ...current.source, name: 'An extremely long lecture filename that must truncate.pdf' } }));
        window.pickerTest.editor.commands.setTextSelection(section ? 3 : 5);
      }, section);
      await assertCompactStrip();
      assert.deepEqual(await note.boundingBox(), narrowNoteBounds);
      const cursor = await page.evaluate(() => window.pickerTest.editor.state.selection.from);
      await page.evaluate(() => window.pickerTest.editor.view.focus());
      await page.keyboard.press(shortcut);
      assert.deepEqual(await page.evaluate(() => window.pickerTest.calls.at(-1)), { position: cursor });
      await page.evaluate(() => window.pickerTest.control.finish());
    }
    await page.evaluate(() => window.pickerTest.draft());
    await page.getByRole('button', { name: 'Dismiss quote', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.pickerTest.pendingPdfQuote.state), null);
    await page.evaluate(() => window.pickerTest.setModuleId('module-other'));
    await page.waitForFunction(() => window.pickerTest.calls.length === 0);
    await page.evaluate(() => window.pickerTest.draft());
    assert.equal(await page.getByRole('button', { name: 'Choose section', exact: true }).isDisabled(), true);
    assert.equal(await insertQuote.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Dismiss quote', exact: true }).isEnabled(), true);
    await page.getByText('Waiting for note…', { exact: true }).waitFor();
    await page.keyboard.press('Control+Enter');
    assert.deepEqual(await page.evaluate(() => window.pickerTest.calls), []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
