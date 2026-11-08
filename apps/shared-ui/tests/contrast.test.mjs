import { browserHarness } from "./support/browser.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { measureContrast } from './helpers-contrast.mjs';

const { createServer, webkit } = browserHarness(import.meta.url);

// Protects readable rendered text through token, utility and state changes. Existing
// editor tests check selection/schema, but do not measure the colors WebKit paints.
test('light and dark rendered UI contrast', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  const report = [];
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contrast.html`);
    await page.waitForFunction(() => window.contrastReady);
    for (const dark of [false, true]) {
      await page.evaluate(dark => {
        document.documentElement.classList.toggle('dark', dark);
        document.querySelector('#audit').replaceChildren();
      }, dark);
      await page.evaluate(() => window.renderContrastControls());
      await page.evaluate(() => document.fonts.ready);
      const pairs = await page.evaluate(measureContrast);
      assert.ok(pairs.length > 10, 'real controls must be measured');
      report.push(...pairs.map(pair => ({ theme: dark ? 'dark' : 'light', ...pair })));
    }
    // Exercise the actual editor DOM and its selection decorations, not only
    // synthetic combinations: node views/KaTeX can add their own ink and fills.
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(() => {
      const colors = ['yellow', 'green', 'blue', 'pink', 'purple'];
      editor.commands.setContent(colors.map(color => `<h3><mark data-color="${color}">Heading</mark></h3><p><mark data-color="${color}">Normal <strong>bold</strong> <code>code</code> <a href="https://example.com">link</a></mark></p>`).join(''));
      editor.commands.insertContent({ type: 'paragraph', content: [{ type: 'inlineMath', marks: [{ type: 'highlight', attrs: { color: 'blue' } }], content: [{ type: 'text', text: 'x^2' }] }] });
    });
    for (const dark of [false, true]) for (const selected of [false, true]) {
      await page.evaluate(({ dark, selected }) => {
        document.documentElement.classList.toggle('dark', dark);
        if (selected) editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
        else editor.commands.setTextSelection(1);
      }, { dark, selected });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const pairs = await page.evaluate(measureContrast, '#root');
      assert.ok(pairs.length > 20, 'real editor content must be measured');
      report.push(...pairs.map(pair => ({ ...pair, theme: dark ? 'dark' : 'light', label: `editor ${selected ? 'selected' : ''} ${pair.label}` })));
    }
    if (process.env.CONTRAST_REPORT) await writeFile(process.env.CONTRAST_REPORT, JSON.stringify(report, null, 2));
    const failures = report.filter(p => p.ratio + .005 < p.minimum);
    assert.equal(failures.length, 0, `${failures.length} contrast failures:\n${failures.slice(0, 65).map(p => `${p.theme} ${p.label}: ${p.ratio.toFixed(2)} < ${p.minimum} (${p.foreground} on ${p.background})`).join('\n')}`);
  } finally { await browser?.close(); await server.close(); }
});
