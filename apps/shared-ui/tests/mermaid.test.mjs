import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { browserHarness } from "./support/browser.mjs";

const { createServer } = browserHarness(import.meta.url);

test("Mermaid source opens with arrows and clicks, previews edits, and recovers from invalid input", { timeout: 60000 }, async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/mermaid.html`);
    const preview = page.locator(".mermaid-preview");
    const source = page.locator(".mermaid-block pre");
    await preview.locator("svg").waitFor();
    assert.equal(await source.isVisible(), false);
    assert.equal(await page.locator("pre code.language-js").textContent(), "const answer = 42;");
    await page.evaluate(() => window.editor.commands.focus(7));
    await page.keyboard.press("ArrowRight");
    assert.equal(await source.isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await source.isVisible(), false);
    await preview.click();
    assert.equal(await source.isVisible(), true);
    await page.keyboard.press("ArrowDown");
    assert.equal(await source.isVisible(), false);
    await page.keyboard.press("ArrowUp");
    assert.equal(await source.isVisible(), true);
    await page.evaluate(() => {
      const { state, view } = window.editor;
      const { $from } = state.selection;
      view.dispatch(state.tr.insertText('graph TD\nA[Updated] --> B', $from.start(), $from.end()));
    });
    await page.waitForFunction(() => document.querySelector('.mermaid-preview svg')?.textContent.includes('Updated'));
    await page.evaluate(() => {
      const { state, view } = window.editor;
      const { $from } = state.selection;
      view.dispatch(state.tr.insertText('<img src=x onerror=alert(1)>', $from.start(), $from.end()));
    });
    await page.locator('.mermaid-preview.has-error').waitFor();
    assert.equal(await preview.locator('img').count(), 0);
    await page.evaluate(() => {
      const { state, view } = window.editor;
      const { $from } = state.selection;
      view.dispatch(state.tr.insertText('graph LR\nA[Recovered] --> B', $from.start(), $from.end()));
    });
    await page.waitForFunction(() => document.querySelector('.mermaid-preview svg')?.textContent.includes('Recovered'));
    await page.keyboard.press('Escape');
    assert.equal(await source.isVisible(), false);
    assert.ok((await page.evaluate(() => window.editor.getHTML())).includes('language-mermaid'));
    assert.equal(await page.evaluate(() => window.editor.getHTML().includes('<svg')), false);
  } finally {
    await browser?.close();
    await server.close();
  }
});
