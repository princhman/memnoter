import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';

test('WK review host scrolls long questions and revealed answers within its viewport', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const cacheDir = await mkdtemp(`${root}node_modules/.memnoter-review-`);
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
    await page.addInitScript(() => {
      window.webkit = { messageHandlers: { memnoter: { postMessage() {} } } };
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/review-native.html`);
    await page.waitForFunction(() => window.memnoterReview);
    for (const revealed of [false, true]) {
      await page.evaluate(revealed => window.memnoterReview.show({
        id: 'long', reps: 0, kind: 'basic',
        front: [{ type: 'text', text: 'Question line\n'.repeat(100) + 'Question end' }],
        back: [{ type: 'text', text: 'Answer line\n'.repeat(100) + 'Answer end' }],
      }, revealed), revealed);
      await page.waitForFunction(revealed => document.querySelectorAll('.card-face').length === (revealed ? 2 : 1), revealed);
      const face = page.locator('.card-face').last();
      await face.waitFor();
      await page.locator('main').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const geometry = await face.evaluate(node => {
        const main = node.closest('main');
        const range = document.createRange();
        range.selectNodeContents(node);
        const last = [...range.getClientRects()].at(-1);
        return { scroll: main.scrollTop, bottom: last.bottom, viewport: innerHeight, pageScroll: scrollY };
      });
      assert.ok(geometry.scroll > 0, 'Long face must scroll internally');
      assert.ok(geometry.bottom <= geometry.viewport - 31, 'Last line must clear bottom padding');
      assert.equal(geometry.pageScroll, 0);
    }
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
