import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

test("card popup omits empty headings and new badges while retaining answers and other states", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/editor.html`);
    for (const [answer, state, expected] of [
      [null, 0, "Due now"], ["Forward", 0, "ForwardDue now"], ["Reverse", 0, "ReverseDue now"],
      ["Paris", 2, "ParisReviewDue now"], [null, 1, "LearningDue now"],
      [null, 3, "RelearningDue now"], [null, null, "UnsavedNot saved yet"],
    ]) {
      await page.evaluate(async ({ answer, state }) => {
        const { cardInfo } = await import("/src/lib/flashcards.ts");
        const schedule = state === null ? undefined : { id: "card", state, dueAt: 10, createdAt: 0, lastReviewAt: null };
        document.body.replaceChildren(cardInfo([{ answer, schedule }], true, 20, null));
      }, { answer, state });
      const details = page.getByRole("group", { name: "Card details" });
      await details.focus();
      assert.ok((await details.getByRole("tooltip").textContent()).startsWith(expected));
      assert.equal(await details.getByText("New", { exact: true }).count(), 0);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("a foldable block becomes one cloze note and stays one when folded", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/cloze-notes.html`);
    const note = () => page.evaluate(() => window.editor.state.doc.firstChild.attrs.clozeNote);
    await page.locator(".foldable-block").hover();
    await page.getByRole("button", { name: "Make one note" }).click();
    const id = await note();
    assert.ok(id);
    assert.equal(await page.getByRole("button", { name: "Make one note" }).count(), 0);
    await page.locator(".foldable-block-toggle").click();
    assert.equal(await page.evaluate(() => window.editor.state.doc.firstChild.attrs.open), false);
    assert.equal(await note(), id, "folding keeps the note");
  } finally {
    await browser?.close();
    await server.close();
  }
});
