import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

test("real card decorations hide braces and tint prose and rendered math in either theme", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => !!window.editor);
    await page.evaluate(() => editor.commands.setContent({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Recall {{answer " }, { type: "inlineMath", content: [{ type: "text", text: "x^2" }] }, { type: "text", text: "}}" }] },
      { type: "paragraph", content: [{ type: "text", text: "Question :: Answer" }] },
    ] }));
    for (const dark of [false, true]) for (const active of [false, true]) {
      await page.evaluate(({ dark, active }) => {
        document.documentElement.classList.toggle("dark", dark);
        editor.commands.setTextSelection(active ? 5 : editor.state.doc.content.size - 1);
      }, { dark, active });
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const styles = await page.evaluate(() => {
        const read = selector => [...document.querySelectorAll(selector)].map(el => {
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          return { text: el.textContent, size: parseFloat(s.fontSize), display: s.display, background: s.backgroundColor, shadow: s.boxShadow, width: r.width, height: r.height };
        });
        return { braces: read(".cloze-brace"), text: read(".cloze-text"), math: read(".cloze-math .inline-math-widget") };
      });
      assert.ok(styles.braces.length >= 2);
      assert.ok(styles.braces.every(s => s.size === 0 && s.display !== "none"));
      assert.ok(styles.text.length > 0 && styles.math.length > 0);
      for (const s of [...styles.text, ...styles.math]) {
        assert.notEqual(s.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(s.shadow, "none", "answers remain underlined");
      }
      assert.ok(styles.text.some(s => s.width > 0 && s.height > 0));
      assert.ok(styles.math.every(s => s.width > 0 && s.height > 0));
      assert.equal(styles.text[0].background, styles.math[0].background);
    }
    assert.equal(await page.evaluate(() => editor.state.doc.textContent), "Recall {{answer x^2}}Question :: Answer");
  } finally { await browser?.close(); await server.close(); }
});
