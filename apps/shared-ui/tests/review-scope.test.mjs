// A grade still being written when the review switches module belongs to the
// old session: it must not put the old module's cards or undo history into
// the new one. Runs the app in WebKit against a fake Tauri backend.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
let server, browser, url;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  browser = await webkit.launch();
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("a grade finishing after a scope change leaves the new review alone", async () => {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript(() => {
    let callbacks = 0;
    const card = (id, moduleId, text) => ({
      id, moduleId, moduleName: moduleId === "a" ? "Alpha" : "Beta", section: [], kind: "basic",
      front: [{ type: "text", text }], back: [{ type: "text", text: "answer" }],
      dueAt: Date.now() - 60_000, stability: 0, stabilityFast: 0, difficulty: 0, scheduledDays: 0, learningStep: 0,
      state: 0, scheduleStatus: "new", lastReviewAt: null, reps: 0, lapses: 0, fsrsModel: null,
    });
    const cards = [card("a1", "a", "Alpha question"), card("b1", "b", "Beta question")];
    window.__grades = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callbacks,
      unregisterCallback() {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
        if (command === "due_cards") return cards.filter((c) => !args.moduleId || c.moduleId === args.moduleId);
        // The grade's write waits until the test lets it finish.
        if (command === "review_card") return new Promise((resolve) => window.__grades.push(resolve));
        if (["due_counts", "unindexed_card_modules", "unindexed_modules", "search_notes", "card_schedules"].includes(command)) return [];
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  try {
    await page.goto(`${url}/review?module=a`);
    await page.getByText("Alpha question").waitFor();
    await page.keyboard.press("Space");
    await page.keyboard.press("1");
    await page.waitForFunction(() => window.__grades.length === 1);

    await page.getByRole("button", { name: "Select review module" }).click();
    await page.getByRole("menuitemradio", { name: "Beta" }).click();
    await page.evaluate(() => window.__grades[0]());

    await page.getByText("Beta question").waitFor();
    // Let anything the finished grade would do land.
    await page.waitForTimeout(300);
    assert.equal(await page.getByText("Alpha question").count(), 0);
    assert.ok(await page.getByRole("button", { name: "Undo" }).isDisabled());
  } finally {
    await page.close();
  }
});
