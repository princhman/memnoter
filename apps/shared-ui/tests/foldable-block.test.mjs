import { browserHarness } from './support/browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createServer, webkit } = browserHarness(import.meta.url);

test('foldable shortcut preserves selected blocks and markdown starts in the title', { timeout: 60_000 }, async () => {
  const server = await createServer({ logLevel: 'error', server: { port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
    await page.waitForFunction(() => window.editor);
    const shortcut = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta+Alt+Shift+f' : 'Control+Alt+Shift+f');
    await page.evaluate(() => {
      editor.commands.setContent('<p>Before</p><p><strong>First</strong> selected block</p><p>Second selected block</p><p>After</p>');
      const positions = [];
      editor.state.doc.forEach((node, pos) => positions.push(pos));
      editor.commands.setTextSelection({ from: positions[1] + 1, to: positions[2] + 5 });
      editor.view.focus();
    });
    await page.keyboard.press(shortcut);
    assert.equal(await page.locator('.foldable-block').count(), 1);
    assert.deepEqual(await page.evaluate(() => editor.getJSON().content.map(node => node.type)), ['paragraph', 'details', 'paragraph']);
    assert.equal(await page.locator('.foldable-block strong').textContent(), 'First');
    assert.equal(await page.locator('.foldable-block [data-type="detailsContent"]').textContent(), 'First selected blockSecond selected block');
    assert.equal(await page.locator('.foldable-block [data-type="detailsContent"]').isVisible(), true);
    await page.keyboard.type('Example title');
    assert.equal(await page.locator('summary').textContent(), 'Example title');
    await page.locator('.foldable-block-toggle').click();
    assert.equal(await page.locator('.foldable-block [data-type="detailsContent"]').isVisible(), false);

    await page.evaluate(() => {
      editor.commands.setContent('<p></p>');
      editor.commands.setTextSelection(1);
      editor.view.focus();
    });
    await page.keyboard.type('>>> ');
    assert.equal(await page.locator('.foldable-block').count(), 1);
    await page.keyboard.type('Markdown title');
    assert.equal(await page.locator('summary').textContent(), 'Markdown title');
    await page.evaluate(() => {
      editor.commands.setContent('<p>Current block</p>');
      editor.commands.setTextSelection(4);
      editor.view.focus();
    });
    await page.keyboard.press(shortcut);
    assert.equal(await page.locator('.foldable-block [data-type="detailsContent"]').textContent(), 'Current block');
  } finally {
    await browser?.close();
    await server.close();
  }
});
