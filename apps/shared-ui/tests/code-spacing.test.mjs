import { browserHarness } from "./support/browser.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const { createServer, webkit } = browserHarness(import.meta.url);

test("code keeps spaces while prose and literal punctuation retain native input", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    for (const inline of [false, true]) {
      for (const inputType of ["insertText", "insertReplacementText"]) {
        const result = await page.evaluate(({ inline, inputType }) => {
          editor.commands.setContent(inline ? '<p><code>value </code></p>' : '<pre><code>value </code></pre>', { parseOptions: { preserveWhitespace: 'full' } });
          editor.commands.setTextSelection(7);
          const text = editor.view.dom.querySelector("code").firstChild;
          const range = new StaticRange({ startContainer: text, startOffset: 5, endContainer: text, endOffset: 6 });
          const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: ". " });
          // InputEventInit cannot supply native target ranges for a synthetic event.
          Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
          editor.view.dom.dispatchEvent(event);
          return { prevented: event.defaultPrevented, text: editor.state.doc.textContent };
        }, { inline, inputType });
        assert.deepEqual(result, { prevented: true, text: "value  " }, `${inline ? "inline" : "block"} ${inputType}`);
        if (process.env.PROOF_DIR) await page.waitForTimeout(700);
      }
      await page.evaluate(inline => {
        editor.commands.setContent(inline ? '<p><code>value</code></p>' : '<pre><code>value</code></pre>');
        editor.commands.focus("end");
      }, inline);
      await page.keyboard.type("  next");
      assert.equal(await page.evaluate(() => editor.state.doc.textContent), "value  next");
    }
    for (const [html, data, start, end] of [
      ["<p>value </p>", ". ", 5, 6],
      ["<pre><code>value</code></pre>", ". ", 5, 5],
      ["<pre><code>value </code></pre>", "corrected", 0, 6],
    ]) {
      const prevented = await page.evaluate(({ html, data, start, end }) => {
        editor.commands.setContent(html, { parseOptions: { preserveWhitespace: 'full' } });
        editor.commands.setTextSelection(end + 1);
        const text = editor.view.dom.querySelector("code, p").firstChild;
        const range = new StaticRange({ startContainer: text, startOffset: start, endContainer: text, endOffset: end });
        const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data });
        Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
        editor.view.dom.dispatchEvent(event);
        return event.defaultPrevented;
      }, { html, data, start, end });
      assert.equal(prevented, false, "leave prose, literal periods, and other corrections to native input");
    }
  } finally { await browser?.close(); await server.close(); }
});
