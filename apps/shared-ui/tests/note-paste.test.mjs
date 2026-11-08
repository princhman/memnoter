import { browserHarness } from "./support/browser.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

let server, browser, page;
const errors = [];
const realNote = fileURLToPath(new URL("./fixtures/Vault/Topics/Memory.md", import.meta.url));
before(async () => {
  const root = new URL("../", import.meta.url).pathname;
  server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
  await page.waitForFunction(() => !!window.editor);
});
after(async () => { await browser?.close(); await server?.close(); });
async function paste(data) {
  await page.evaluate(data => {
    const clipboardData = new DataTransfer();
    for (const [type, value] of Object.entries(data)) clipboardData.setData(type, value);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    editor.state.doc.check();
  }, data);
  assert.deepEqual(errors.splice(0), [], "paste must not throw in the DOM handler");
}
test("whole Obsidian source note detects Markdown after leading prose", async () => {
  await page.evaluate(() => editor.commands.setContent("<p></p>"));
  await paste({ "text/plain": readFileSync(realNote, "utf8") });
  assert.equal(await page.locator("h1").first().textContent(), "Memory in C");
  assert.equal(await page.locator("li").count(), 2);
  assert.ok((await page.evaluate(() => editor.getText())).includes("[image:"));
});
test("reading view uses HTML when plain text has lost Markdown markers", async () => {
  await page.evaluate(() => editor.commands.setContent("<p></p>"));
  await paste({ "text/html": "<p>Module: Principles</p><h1>Memory in C</h1><ul><li>Stack</li><li>Heap</li></ul><p><strong>Lifetime</strong></p>", "text/plain": "Module: Principles\nMemory in C\nStack\nHeap\nLifetime" });
  assert.equal(await page.locator("h1").textContent(), "Memory in C");
  assert.equal(await page.locator("li").count(), 2);
  assert.equal(await page.locator("strong").textContent(), "Lifetime");
});
test("whole real note in reading-view clipboard shape retains HTML structure", async () => {
  // Literal clipboard pair from the fixture's reading view, independent of the Markdown renderer.
  const html = '<p>Module: Vault</p><h1>Memory in C</h1><p>Stack and heap have different lifetimes.</p><ul><li>Automatic storage</li><li>Dynamic storage</li></ul><pre><code>int value = 42;</code></pre><pre><code>==literal== [[raw]]</code></pre><table><tr><th>Storage</th><th>Lifetime</th></tr><tr><td>Stack</td><td>Scope</td></tr><tr><td>Heap</td><td>Explicit</td></tr></table><p>[image]</p>';
  const plain = 'Module: Vault\nMemory in C\nStack and heap have different lifetimes.\nAutomatic storage\nDynamic storage\nint value = 42;\n==literal== [[raw]]\nStorage Lifetime Stack Scope Heap Explicit [image]';
  await page.evaluate(() => editor.commands.setContent("<p></p>"));
  await paste({ "text/html": html, "text/plain": plain });
  assert.equal(await page.locator("h1").first().textContent(), "Memory in C");
  assert.equal(await page.locator("pre").count(), 2);
});
test("whole internal note clipboard preserves blocks, images, formulas and distinct cards at heading and select-all targets", async () => {
  const data = await page.evaluate(() => {
    editor.commands.setContent('<h1>Study</h1><p>Question :: Answer</p><ul><li><p>Remember {{value}}</p></li></ul><p><span data-type="inline-math">x^2</span><mark data-color="yellow">highlight</mark></p><div data-type="math-block">a+b</div><img data-file-id="throwaway" data-image-id="source-image"><table><tr><td><p>cell</p></td></tr></table>');
    editor.commands.selectAll();
    const clipboardData = new DataTransfer();
    editor.view.dom.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    window.originalCards = extractCards(editor.state.doc).map(c => c.id);
    return Object.fromEntries(Array.from(clipboardData.types, type => [type, clipboardData.getData(type)]));
  });
  assert.match(data["text/html"], /data-pm-slice/);
  for (const target of ["empty", "heading", "select-all", "same-note"]) {
    await page.evaluate(target => {
      if (target !== "same-note") editor.commands.setContent(target === "empty" ? "<p></p>" : "<h1>Target</h1><p>old</p>");
      if (target === "select-all") editor.commands.selectAll();
      else editor.commands.setTextSelection(target === "same-note" ? editor.state.doc.content.size - 1 : 1);
    }, target);
    await paste(data);
    const result = await page.evaluate(() => {
      const counts = {};
      editor.state.doc.descendants(n => { counts[n.type.name] = (counts[n.type.name] ?? 0) + 1; });
      return { counts, cards: extractCards(editor.state.doc).map(c => c.id), text: editor.getText() };
    });
    for (const type of ["image", "inlineMath", "mathBlock", "table", "bulletList"]) assert.ok(result.counts[type] >= 1, `${target}: ${type}`);
    assert.equal(new Set(result.cards).size, result.cards.length, target);
    assert.ok(result.text.includes("x^2"));
    assert.ok(result.text.includes("a+b"));
    if (target === "select-all") assert.ok(!result.text.includes("old"));
  }
});
test("keyboard copy and paste replaces a selected whole note", async () => {
  await page.evaluate(() => {
    editor.commands.setContent('<h1>Keyboard source</h1><p>Question :: {{Answer}}</p>');
    editor.commands.focus();
  });
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+c");
  await page.evaluate(() => { editor.commands.setContent('<h1>Target</h1><p>old</p>'); editor.commands.focus(); });
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+v");
  assert.ok((await page.evaluate(() => editor.getText())).includes("Keyboard source"));
  assert.ok(!(await page.evaluate(() => editor.getText())).includes("old"));
});
test("display math in a pasted Markdown table retains its formula inside the cell", async () => {
  await page.evaluate(() => editor.commands.setContent("<p></p>"));
  await paste({ "text/plain": "| Formula |\n|---|\n| $$x^2$$ |" });
  assert.equal(await page.evaluate(() => editor.state.doc.child(0).child(1).child(0).textContent), "x^2");
  assert.equal(await page.evaluate(() => editor.state.doc.child(0).type.name), "table");
});
