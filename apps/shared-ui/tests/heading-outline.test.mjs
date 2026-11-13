import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { browserHarness } from './support/browser.mjs';
const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, page;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen(); browser = await webkit.launch(); page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
  await page.waitForFunction(() => !!window.editor);
});
after(async () => { await browser?.close(); await server?.close(); });
const levels = () => page.evaluate(() => editor.getJSON().content.filter(n => n.type === 'heading').map(n => n.attrs.level));
async function setup(values, empty = false) {
  await page.evaluate(({ values, empty }) => {
    editor.commands.setContent({ type: 'doc', content: [
      ...(empty ? [{ type: 'paragraph' }] : []),
      ...values.map((level, i) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: `Section ${i + 1} (h${level})` }] })),
    ] });
    editor.commands.setTextSelection(1); editor.view.focus();
  }, { values, empty });
}
test('PRI-342: insert title adopts only the next section', async () => {
  await setup([1, 2, 3, 4, 1], true);
  if (process.env.PROOF_DIR) await page.waitForTimeout(800);
  await page.keyboard.type('/insert title');
  await page.getByRole('option', { name: /Insert heading above/ }).click();
  await page.keyboard.type('New parent');
  assert.deepEqual(await levels(), [1, 2, 3, 4, 5, 1]);
  if (process.env.PROOF_DIR) await page.waitForTimeout(1000);
});
test('PRI-342: removing a parent promotes all branches of its section', async () => {
  await setup([1, 2, 3, 2, 3, 1]);
  if (process.env.PROOF_DIR) await page.waitForTimeout(800);
  await page.keyboard.press('Backspace');
  assert.deepEqual(await levels(), [1, 2, 1, 2, 1]);
  if (process.env.PROOF_DIR) await page.waitForTimeout(1000);
});
