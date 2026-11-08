import { browserHarness } from "./support/browser.mjs";
import { installReviewHost } from "./support/review-host.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

// Real pointer and keyboard interactions protect selection across the portaled
// picker, as well as the official extension's input rule and collaborative schema.
test("highlight picker, syntax and old-schema compatibility", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(() => {
      editor.commands.setContent("<p>Calm colours</p>");
      editor.chain().focus().setTextSelection({ from: 1, to: 5 }).run();
    });
    const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
    await toolbar.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Highlight", exact: true }).click();
    assert.equal(await page.locator(".tiptap mark").getAttribute("data-color"), "yellow");
    await page.getByRole("button", { name: "Highlight colours" }).click();
    await page.getByRole("menuitem", { name: "Blue", exact: true }).click();
    await toolbar.waitFor({ state: "visible" });
    assert.equal(await page.locator(".tiptap mark").getAttribute("data-color"), "blue");
    assert.deepEqual(await page.evaluate(() => [editor.state.selection.from, editor.state.selection.to]), [1, 5]);
    // Wait for the portaled menu's exit animation and final focus restoration
    // before beginning a second, keyboard interaction.
    await page.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "detached" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Keyboard opens the picker and chooses its first colour.
    await page.getByRole("button", { name: "Highlight colours" }).focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "Yellow", exact: true }).waitFor();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Yellow");
    await page.keyboard.press("Enter");
    await toolbar.waitFor({ state: "visible" });
    assert.equal(await page.locator(".tiptap mark").getAttribute("data-color"), "yellow");
    await page.evaluate(async () => {
      editor.commands.setContent("<p></p>"); editor.commands.focus("start");
    });
    await page.keyboard.type("==gentle==");
    assert.equal(await page.locator(".tiptap mark").textContent(), "gentle");
    assert.equal(await page.locator(".tiptap mark").getAttribute("data-color"), "yellow");
    assert.equal(await page.locator(".tiptap mark").getAttribute("style"), null);
    await page.evaluate(() => editor.chain().focus().setTextSelection({ from: 1, to: 7 }).run());
    await page.keyboard.press("Meta+Shift+h");
    assert.equal(await page.locator(".tiptap mark").count(), 0);
    await page.keyboard.press("Meta+Shift+h");
    assert.equal(await page.locator(".tiptap mark").getAttribute("data-color"), "yellow");
    // Highlighted inline math and cloze text use the same semantic colour in
    // the editor and the shared face mounted by native review.
    const card = await page.evaluate(async () => {
      const { extractCards } = await import("/src/lib/cards.ts");
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", attrs: { cardId: "colour-card" }, content: [
        { type: "text", text: "Question {{" },
        { type: "text", text: "answer", marks: [{ type: "highlight", attrs: { color: "green" } }] },
        { type: "inlineMath", marks: [{ type: "highlight", attrs: { color: "blue" } }], content: [{ type: "text", text: "x^2" }] },
        { type: "text", text: "}}" },
      ] }] });
      return extractCards(editor.state.doc)[0];
    });
    assert.equal(await page.locator('.tiptap mark[data-color="blue"] .inline-math-widget').count(), 1);
    assert.equal(await page.locator('.tiptap mark[data-color="green"] .cloze-text, .tiptap .cloze-text mark[data-color="green"], .tiptap mark.cloze-text[data-color="green"]').count(), 1);
    const review = await browser.newPage();
    await review.addInitScript(installReviewHost);
    await review.goto(`http://localhost:${server.httpServer.address().port}/review-native.html`);
    await review.waitForFunction(() => window.memnoterReview);
    await review.evaluate(card => window.loadCard({ ...card, reps: 0 }, true), card);
    await review.locator('.card-face mark[data-color="green"]').waitFor();
    assert.equal(await review.locator('.card-face [data-color="blue"] .katex').count(), 1);
    const backgrounds = [];
    for (const dark of [false, true]) {
      backgrounds.push(await review.evaluate(dark => {
        document.documentElement.classList.toggle("dark", dark);
        return getComputedStyle(document.querySelector('.card-face mark')).backgroundColor;
      }, dark));
    }
    assert.notEqual(backgrounds[0], backgrounds[1]);
    await review.close();
    await page.evaluate(() => editor.commands.setContent('<p><mark data-color="purple">gentle</mark></p>'));
    const compatibility = await page.evaluate(async () => {
      const { openWithOldSchema } = await import("/tests/browser/highlight-compatibility.ts");
      return openWithOldSchema(editor);
    });
    assert.equal(compatibility.editorText, "");
    assert.equal(compatibility.storedText.includes("gentle"), false);
  } finally {
    await browser?.close(); await server.close();
  }
});
