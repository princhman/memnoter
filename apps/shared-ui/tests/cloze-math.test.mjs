import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { webkit } from "playwright";

test("cloze math is decorated only inside the answer and preserves selection and editing", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const cacheDir = await mkdtemp(`${root}node_modules/.cloze-vite-`);
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 960, height: 320 }, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    await page.addStyleTag({ content: '.tiptap, .tiptap * { caret-color: transparent !important; } [aria-label="Text formatting"] { visibility: hidden !important; }' });
    await page.evaluate(() => {
      const math = text => ({ type: "inlineMath", content: [{ type: "text", text }] });
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "{{ holds " },
        { type: "text", marks: [{ type: "bold" }], text: "for " },
        math("cam"), { type: "text", text: " every time }} outside " }, math("x"),
      ] }] });
      editor.commands.focus("end");
    });
    await page.waitForFunction(() => document.querySelectorAll(".inline-math-widget .katex").length === 2);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.locator(".inline-math").evaluateAll(nodes => nodes.map(n => n.classList.contains("cloze-math"))), [true, false]);
    const artifacts = process.env.CLOZE_ARTIFACTS;
    if (artifacts) await mkdir(artifacts, { recursive: true });
    for (const dark of [false, true]) {
      await page.evaluate(dark => {
        document.documentElement.classList.toggle("dark", dark);
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      }, dark);
      const prefix = `${artifacts}/${dark ? "dark" : "light"}-cloze`;
      if (artifacts) await page.screenshot({ path: `${prefix}-unselected.png`, caret: "initial", animations: "disabled" });
      const normal = await page.locator(".cloze-math .inline-math-widget").evaluate(n => getComputedStyle(n).backgroundColor);
      await page.evaluate(() => {
        let mathPos;
        editor.state.doc.descendants((node, pos) => { if (node.type.name === "inlineMath" && mathPos === undefined) mathPos = pos; });
        editor.commands.setTextSelection({ from: 5, to: mathPos + editor.state.doc.nodeAt(mathPos).nodeSize + 6 });
      });
      await page.locator(".cloze-math .inline-math-widget.is-selected").waitFor();
      assert.notEqual(await page.locator(".cloze-math .inline-math-widget").evaluate(n => getComputedStyle(n).backgroundColor), normal);
      if (artifacts) await page.screenshot({ path: `${prefix}-selected.png`, caret: "initial", animations: "disabled" });
    }
    await page.evaluate(() => {
      let pos;
      editor.state.doc.descendants((node, p) => { if (node.type.name === "inlineMath" && pos === undefined) pos = p; });
      editor.commands.setTextSelection({ from: pos + 1, to: pos + 3 });
    });
    assert.equal(await page.locator(".cloze-math .inline-math-widget").isVisible(), false);
    assert.equal(await page.locator(".cloze-math .inline-math-source .cloze-text").first().isVisible(), true);
    assert.equal(await page.locator(".cloze-math .inline-math-source .text-range-selected").isVisible(), true);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
