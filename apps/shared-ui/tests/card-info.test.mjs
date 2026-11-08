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
    const rows = await page.evaluate(async () => {
      const { cardInfo } = await import("/src/lib/flashcards.ts");
      return [
        { answer: null, state: 0 },
        { answer: "Forward", state: 0 },
        { answer: "Reverse", state: 0 },
        { answer: "Paris", state: 2 },
        { answer: null, state: 1 },
        { answer: null, state: 3 },
        { answer: null, state: null },
      ].map(({ answer, state }) => {
        const schedule = state === null ? undefined : { id: "card", state, dueAt: 10, createdAt: 0, lastReviewAt: null };
        const popup = cardInfo([{ answer, schedule }], true, 20, null);
        return {
          heading: popup.querySelector(".card-info-heading")?.textContent ?? null,
          due: popup.querySelector(".card-info-due").textContent,
          dot: popup.dataset.state,
        };
      });
    });
    assert.deepEqual(rows.map(r => r.heading), [null, "Forward", "Reverse", "ParisReview", "Learning", "Relearning", "Unsaved"]);
    assert.equal(rows[0].due, "Due now");
    assert.equal(rows[0].dot, "new");
    assert.equal(rows[6].due, "Not saved yet");
  } finally {
    await browser?.close();
    await server.close();
  }
});
