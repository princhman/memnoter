import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { textPdfBytes } from './browser/pdf-text-selection-pdf.mjs';
import { readPdfAnnotations } from '../src/lib/pdf-annotations.ts';

// The bridge boundary stores actual Yjs updates; all selection and mutation
// controls below are the production reader and production annotation hook.
test('PDF reader highlights/comments persist independently, retain line geometry, and preserve quoting', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  const persisted = new Y.Doc();
  let saves = 0, fail = false;
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/annotation-command', async route => {
      const { command, args } = route.request().postDataJSON();
      if (command === 'save_annotation_update') {
        if (fail) return route.fulfill({ status: 500, body: 'Disk unavailable' });
        assert.equal(args.generation, 'ui-test-generation');
        Y.applyUpdate(persisted, new Uint8Array(args.bytes)); saves++;
      }
      await route.fulfill({ json: { state: saves ? Array.from(Y.encodeStateAsUpdate(persisted)) : null, revision: saves, generation: 'ui-test-generation' } });
    });
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async (command, args) => {
      if (command === 'get_content') return { state: [], updates: [], files: [] };
      if (command === 'document_path') return '/text.pdf';
      if (command === 'load_annotations' || command === 'save_annotation_update') {
        const response = await fetch('/annotation-command', { method: 'POST', body: JSON.stringify({command, args}) });
        if (!response.ok) throw new Error(await response.text()); return response.json();
      }
      throw new Error(command);
    } } });`);
    await page.route('**/text.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-annotation-ui.html`);
    const viewer = page.locator('#viewer');
    const first = viewer.locator('[data-pdf-page="1"] .textLayer span').filter({ hasText: 'Page 1 first line' });
    const second = viewer.locator('[data-pdf-page="2"] .textLayer span').filter({ hasText: 'Second line <plain>.' });
    await first.waitFor(); await second.waitFor();
    const select = async (from = first, to = first) => {
      const a = await from.boundingBox(), b = await to.boundingBox();
      await page.mouse.move(a.x + .5, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width - .5, b.y + b.height / 2, { steps: 20 }); await page.mouse.up();
      await viewer.getByRole('button', { name: 'Highlight', exact: true }).waitFor();
    };
    const waitSaved = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate(readPdfAnnotations(persisted))) return; await page.waitForTimeout(25); }
      assert.fail('annotation state was not saved');
    };
    const originalBounds = await first.boundingBox();
    await select(first, second);
    await viewer.getByRole('button', { name: 'Highlight', exact: true }).click();
    const editor = viewer.getByRole('dialog', { name: 'PDF annotation' });
    await waitSaved(items => items.length === 1);
    assert.equal(await editor.count(), 0, 'highlight applies immediately without opening a comment editor');
    await viewer.getByRole('button', { name: 'Edit PDF highlight', exact: true }).first().click();
    await editor.waitFor();
    assert.equal(await editor.getByRole('textbox').count(), 0, 'a plain highlight opens colour controls, not a comment field');
    assert.equal(await editor.evaluate(element => element === document.activeElement), true, 'opening the menu focuses its surface rather than a colour swatch');
    assert.equal(await page.getByRole('tooltip').filter({ hasText: 'Purple highlight' }).count(), 0, 'opening a highlight does not announce an unrelated colour tooltip');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await editor.getByRole('button', { name: 'Add comment', exact: true }).evaluate(element => element === document.activeElement), true, 'backward tab from the surface stays in the menu');
    await page.keyboard.press('Tab');
    assert.equal(await editor.getByRole('button', { name: 'Purple highlight', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.getByRole('tooltip').filter({ hasText: 'Purple highlight' }).waitFor();
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
    await viewer.getByRole('button', { name: 'Edit PDF highlight', exact: true }).first().click();
    await editor.waitFor();
    assert.equal(await editor.evaluate(element => element === document.activeElement), true);
    const fill = viewer.locator('[data-pdf-annotations] > div').first();
    const purpleFill = await fill.evaluate(element => getComputedStyle(element).backgroundColor);
    await editor.getByRole('button', { name: 'Blue highlight', exact: true }).click();
    await waitSaved(items => items[0]?.color === 'blue');
    const blueFill = await fill.evaluate(element => getComputedStyle(element).backgroundColor);
    assert.notEqual(blueFill, purpleFill, 'recolouring changes the visible PDF fill');
    await editor.getByRole('button', { name: 'Add comment', exact: true }).click();
    let [highlight] = readPdfAnnotations(persisted);
    assert.equal(highlight.kind, 'highlight');
    assert.deepEqual(highlight.anchors.map(anchor => anchor.page), [1, 2]);
    assert.ok(highlight.anchors.every(anchor => anchor.regions.length >= 2));
    assert.ok(highlight.anchors.every(anchor => anchor.regions.every(region => region.height < .06)), 'line fragments must not fill line gaps');
    assert.deepEqual(await first.boundingBox(), originalBounds, 'floating controls must not shift PDF layout');
    assert.equal(await page.locator('#text-draft').textContent(), 'null');
    assert.equal(await editor.getByRole('button', { name: 'Close', exact: true }).count(), 0);
    const trashBounds = await editor.getByRole('button', { name: 'Delete annotation', exact: true }).boundingBox();
    const saveBounds = await editor.getByRole('button', { name: 'Save', exact: true }).boundingBox();
    assert.ok(trashBounds.x < saveBounds.x, 'trash stays left of Save');
    await editor.getByRole('textbox').click();
    assert.equal(await editor.isVisible(), true, 'inside clicks keep the editor open');
    const save = editor.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), true, 'unchanged text has nothing to save');
    const idleSaveBackground = await save.evaluate(element => getComputedStyle(element).backgroundColor);
    await editor.getByRole('textbox').fill('Remember this <plain>');
    assert.equal(await save.isEnabled(), true);
    assert.notEqual(await save.evaluate(element => getComputedStyle(element).backgroundColor), idleSaveBackground, 'Save gains emphasis only for changes');
    await editor.getByRole('textbox').fill('');
    assert.equal(await save.isDisabled(), true, 'reverting an edit restores the idle state');
    assert.equal(await save.evaluate(element => getComputedStyle(element).backgroundColor), idleSaveBackground);
    await editor.getByRole('textbox').fill('Remember this <plain>');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await waitSaved(items => items[0]?.body === 'Remember this <plain>');
    await page.reload(); await first.waitFor();
    await viewer.getByRole('button', { name: 'Edit PDF comment: Remember this <plain>' }).first().click();
    assert.equal(await editor.getByRole('textbox').inputValue(), 'Remember this <plain>');
    assert.equal(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'saved text reopens without changes');
    assert.equal(readPdfAnnotations(persisted)[0].color, 'blue', 'colour survives reload');
    assert.equal(await fill.evaluate(element => getComputedStyle(element).backgroundColor), blueFill);
    await editor.getByRole('textbox').fill('Unsaved changes');
    await page.getByRole('button', { name: 'Outside action', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Outside action', exact: true }).evaluate(element => element === document.activeElement), true, 'dismissal leaves focus on the clicked control');
    assert.equal(await page.locator('#outside-count').textContent(), '1', 'outside action still executes');
    assert.equal(readPdfAnnotations(persisted)[0].body, 'Remember this <plain>', 'dismissal does not save unfinished text');
    await viewer.getByRole('button', { name: 'Edit PDF comment: Remember this <plain>' }).first().click();
    assert.equal(await editor.getByRole('textbox').inputValue(), 'Remember this <plain>');
    fail = true;
    await editor.getByRole('textbox').fill('Keep input after failure');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await viewer.getByRole('alert').waitFor();
    await viewer.getByRole('button', { name: 'Edit PDF comment: Keep input after failure' }).first().click();
    await editor.getByRole('alert').waitFor();
    assert.equal(await editor.getByRole('textbox').inputValue(), 'Keep input after failure', 'background save errors retain the accepted edit for retry');
    fail = false; await editor.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await waitSaved(items => items[0]?.body === 'Keep input after failure');
    await editor.getByRole('button', { name: 'Delete annotation', exact: true }).click();
    await waitSaved(items => items.length === 0);
    await select();
    // Selection is still PDF text while an unrelated control has focus.
    await page.getByRole('button', { name: 'Outside action', exact: true }).focus();
    await page.keyboard.press('Control+Shift+h');
    assert.equal(readPdfAnnotations(persisted).length, 0, 'shortcut ignores unrelated controls');
    await viewer.getByRole('button', { name: 'Highlight', exact: true }).focus();
    for (const extra of [{ repeat: true }, { isComposing: true }]) {
      await viewer.getByRole('button', { name: 'Highlight', exact: true }).dispatchEvent('keydown', { key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true, ...extra });
      assert.equal(readPdfAnnotations(persisted).length, 0);
    }
    await page.keyboard.press('Control+Shift+h');
    await waitSaved(items => items.length === 1 && items[0].color === 'blue');
    assert.equal(await editor.count(), 0, 'keyboard highlight has no comment prompt');
    await viewer.getByRole('button', { name: 'Edit PDF highlight', exact: true }).first().click();
    await editor.getByRole('button', { name: 'Delete annotation', exact: true }).click();
    await waitSaved(items => items.length === 0);
    await select();
    await viewer.getByRole('button', { name: 'Highlight colour', exact: true }).click();
    await viewer.getByRole('button', { name: 'Yellow highlight', exact: true }).click();
    await waitSaved(items => items.length === 1 && items[0].color === 'yellow');
    assert.equal(await editor.count(), 0, 'choosing a colour applies the selected highlight');
    await viewer.getByRole('button', { name: 'Edit PDF highlight', exact: true }).first().click();
    await editor.getByRole('button', { name: 'Delete annotation', exact: true }).click();
    await waitSaved(items => items.length === 0);
    await select(); await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
    assert.equal(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await editor.getByRole('textbox').fill('Unfinished new comment');
    await page.getByRole('button', { name: 'Outside action', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    assert.equal(readPdfAnnotations(persisted).length, 0, 'dismissing a new comment creates nothing');
    await select(); await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
    await editor.getByRole('textbox').fill('Text comment');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await waitSaved(items => items[0]?.kind === 'comment' && items[0]?.body === 'Text comment');
    // Drag through existing highlights still selects text for the independent quote action.
    await select(); await viewer.getByRole('button', { name: 'Quote text', exact: true }).click();
    assert.equal(JSON.parse(await page.locator('#text-draft').textContent()).kind, 'text');
    await page.getByRole('button', { name: 'Clear quote', exact: true }).click();
    await viewer.getByRole('button', { name: 'Annotate area', exact: true }).click();
    const layer = viewer.getByLabel('Drag a region on this PDF page').first();
    const box = await layer.boundingBox();
    await page.mouse.move(box.x + 200, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 280, box.y + 220); await page.mouse.up();
    await viewer.getByRole('button', { name: 'Comment on area', exact: true }).click();
    await editor.getByRole('textbox').fill('Area comment'); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await waitSaved(items => items.length === 2);
    assert.equal(await page.locator('#text-draft').textContent(), 'null');
    // Clicking the fill (rather than its keyboard control) opens the annotation.
    await page.mouse.click(box.x + 220, box.y + 200);
    await editor.waitFor(); assert.equal(await editor.getByRole('textbox').inputValue(), 'Area comment');
    await page.keyboard.press('Escape'); await editor.waitFor({ state: 'detached' });
    await viewer.getByRole('button', { name: 'Annotate area', exact: true }).click();
    await page.mouse.move(box.x + 300, box.y + 260); await page.mouse.down(); await page.mouse.move(box.x + 360, box.y + 290); await page.mouse.up();
    await viewer.getByRole('button', { name: 'Highlight area', exact: true }).click();
    await waitSaved(items => items.length === 3 && items.some(item => item.kind === 'highlight' && !item.excerpt));
    assert.equal(await editor.count(), 0, 'area highlight also applies without a comment prompt');
    await viewer.getByRole('button', { name: 'Edit PDF highlight', exact: true }).click();
    await editor.getByRole('button', { name: 'Delete annotation', exact: true }).click();
    await waitSaved(items => items.length === 2);
    await page.getByRole('button', { name: 'Block writes briefly' }).click();
    assert.equal(await viewer.getByRole('button', { name: 'Annotate area', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); persisted.destroy(); }
});
