import { browserHarness } from "./support/browser.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createServer, webkit } = browserHarness(import.meta.url);

test('WK review host scrolls long questions and revealed answers within its viewport', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
    await page.addInitScript(() => {
      window.installTestBridge({ native: function() {} });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/review-native.html`);
    await page.waitForFunction(() => window.memnoterReview);
    // The same mounted WK host must follow appearance changes without reloading.
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, colorScheme === 'dark');
      const colors = await page.evaluate(() => ({
        scheme: document.documentElement.style.colorScheme,
        background: getComputedStyle(document.body).backgroundColor,
        foreground: getComputedStyle(document.body).color,
      }));
      assert.equal(colors.scheme, colorScheme);
      assert.equal(colors.background, 'rgba(0, 0, 0, 0)', 'Native background shows through');
    }
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
    for (const [id, reps] of [['next', 0], ['next', 1]]) {
      await page.evaluate(({ id, reps }) => window.memnoterReview.show({
        id, reps, kind: 'basic',
        front: [{ type: 'text', text: id + reps + '\nQuestion line'.repeat(100) }],
        back: [{ type: 'text', text: 'Answer line\n'.repeat(100) }],
      }, false), { id, reps });
      await page.waitForFunction(({ id, reps }) =>
        document.querySelectorAll('.card-face').length === 1 &&
        document.querySelector('.card-face').textContent.startsWith(id + reps), { id, reps });
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), 0, 'New card attempt starts at the top');
      await page.locator('main').evaluate(node => { node.scrollTop = 300; });
      await page.evaluate(({ id, reps }) => window.memnoterReview.show({
        id, reps, kind: 'basic',
        front: [{ type: 'text', text: id + reps + '\nQuestion line'.repeat(100) }],
        back: [{ type: 'text', text: 'Answer line\n'.repeat(100) }],
      }, true), { id, reps });
      await page.waitForFunction(() => document.querySelectorAll('.card-face').length === 2);
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), 300, 'Reveal preserves reading position');
    }
  } finally {
    await browser?.close();
    await server.close();

  }
});
