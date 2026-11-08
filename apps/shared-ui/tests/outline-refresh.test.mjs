import { browserHarness } from "./support/browser.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

test("outline navigation, numbering, folding and Yjs stay correct across edits and undo", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, server: { port: 0, strictPort: false, hmr: false, watch: null }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/large-note.html`);
    await page.waitForFunction(() => !!window.openLargeNote);
    await page.evaluate(() => window.openLargeNote({ name: "Outline", entries: [{ path: "Outline.md", text: "# First\n\nSome editable paragraph text.\n\n# Second\n\nAnother editable paragraph text." }] }));
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".heading-number").count(), 2);
    await page.evaluate(() => editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Inserted before headings" }] }));
    assert.equal(await page.evaluate(() => editor.storage.tableOfContents.content.every(item => editor.state.doc.nodeAt(item.pos)?.attrs["data-toc-id"] === item.id)), true);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => editor.storage.tableOfContents.content.map(item => item.textContent).join(",")), "First,Second");
    await page.evaluate(() => editor.commands.toggleFold(editor.storage.tableOfContents.content[0].pos));
    assert.ok(await page.locator(".section-hidden").count() > 0);
    await page.evaluate(() => editor.commands.setFolds([]));
    assert.equal(await page.locator(".section-hidden").count(), 0);
    await page.evaluate(() => editor.commands.undo());
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => editor.state.doc.textContent.includes("Inserted before headings")), false);
    assert.deepEqual(await page.locator(".heading-number").allTextContents(), ["1\u00a0", "2\u00a0"]);
    assert.equal(await page.evaluate(() => {
      editor.state.doc.check();
      return doc.getXmlFragment("default").toString().includes("First");
    }), true);
    // A pending visual callback must not dispatch after teardown.
    await page.evaluate(() => { editor.commands.insertContent("x"); editor.destroy(); });
    await page.waitForTimeout(150);
    assert.deepEqual(errors, [], "teardown must not dispatch into a destroyed editor");
  } finally { await browser?.close(); await server.close(); }
});
