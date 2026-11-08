import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

test("numbering renders hierarchical chapter labels without changing persisted text", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => !!window.editor);
    const before = await page.evaluate(() => {
      editor.commands.setContent([1, 3, 3, 2, 1].map(level => `<h${level}>Title</h${level}>`).join(""));
      return editor.getJSON();
    });
    assert.equal(await page.locator(".heading-number").count(), 0);
    await page.evaluate(async () => {
      const { headingNumberingKey } = await import("/src/lib/heading-numbering.ts");
      editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, true));
    });
    assert.deepEqual(await page.locator(".heading-number").allTextContents(), ["1\u00a0", "1.1\u00a0", "1.1.1\u00a0", "1.2\u00a0", "2\u00a0"]);
    assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);
    await page.evaluate(async () => {
      const { headingNumberingKey } = await import("/src/lib/heading-numbering.ts");
      editor.view.dispatch(editor.state.tr.setMeta(headingNumberingKey, false));
    });
    assert.equal(await page.locator(".heading-number").count(), 0);
  } finally { await browser?.close(); await server.close(); }
});
