// A grade still being written when the review switches module belongs to the
// old session: it must not put the old module's cards or undo history into
// the new one. Runs the app in WebKit against a fake Tauri backend.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "vite";
import { webkit } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
let server, browser, url, cacheDir;

before(async () => {
  cacheDir = await mkdtemp(`${root}/node_modules/.memnoter-review-scope-`);
  server = await createServer({
    root,
    cacheDir,
    configFile: `${root}/vite.config.ts`,
    server: { port: 0, strictPort: false },
    logLevel: "error",
    plugins: [{
      name: "review-test-harness",
      resolveId: (id) => id === "/test-harness" ? id : null,
      load: (id) => id === "/test-harness" ? `
        export { createElement } from "react";
        export { createRoot } from "react-dom/client";
        export { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      ` : null,
    }],
  });
  await server.listen();
  browser = await webkit.launch();
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
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

test("cutoff reloads preserve the current answer, reviewed count and undo/redo", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    let callbacks = 0;
    const cards = ["First", "Second"].map((text, index) => ({
      id: text, moduleId: "a", moduleName: "Alpha", section: [], kind: "basic",
      front: [{ type: "text", text }], back: [{ type: "text", text: "answer" }],
      createdAt: Date.now(), dueAt: Date.now() - 60_000 + index,
      stability: 0, stabilityFast: 0, difficulty: 0, scheduledDays: 0, learningStep: 0,
      state: 0, scheduleStatus: "new", lastReviewAt: null, reps: 0, lapses: 0, fsrsModel: null,
    }));
    window.__loads = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callbacks, unregisterCallback() {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "a", name: "Alpha" }];
        if (command === "due_cards") {
          window.__loads++;
          // Enabling skip removes the currently displayed new card too.
          return structuredClone(cards.filter((c) => c.dueAt <= args.now &&
            (args.createdAtCutoff == null || c.reps > 0)));
        }
        if (command === "review_card") Object.assign(cards.find((c) => c.id === args.cardId), args.card);
        if (command === "undo_review") Object.assign(cards.find((c) => c.id === args.cardId), args.previous);
        if (["due_counts", "unindexed_card_modules", "unindexed_modules", "search_notes", "card_schedules"].includes(command)) return [];
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  });
  const toggle = async (enabled) => {
    const loads = await page.evaluate(() => window.__loads);
    await page.evaluate(async (enabled) => {
      const { setSkipCardsCreatedToday } = await import("/src/lib/store.ts");
      setSkipCardsCreatedToday(enabled);
    }, enabled);
    await page.waitForFunction((loads) => window.__loads > loads, loads);
    // Wait for the loaded queue to commit before exercising its controls.
    await page.waitForTimeout(100);
  };
  try {
    await page.goto(`${url}/review?module=a`);
    await page.getByText("First", { exact: true }).waitFor();
    await page.keyboard.press("Space");
    await page.keyboard.press("4");
    await page.getByText("Second", { exact: true }).waitFor();
    await page.keyboard.press("Space");
    await toggle(true);
    assert.equal(await page.getByText("Second", { exact: true }).count(), 1);
    assert.equal(await page.getByText("answer", { exact: true }).count(), 1);
    assert.ok(await page.getByRole("button", { name: "Undo", exact: true }).isEnabled());
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByText("First", { exact: true }).waitFor();
    await toggle(false);
    assert.ok(await page.getByRole("button", { name: "Redo", exact: true }).isEnabled());
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByText("Second", { exact: true }).waitFor();
    // Clicks, not Space and 4: Redo keeps focus, and Space skips a focused button.
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: /^Easy/ }).click();
    await page.getByText("You reviewed 2 cards.", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("cutoff consumers share an idle-when-disabled day clock and catch up after sleep", async () => {
  const page = await browser.newPage();
  await page.route("**/clock-probe", (route) => route.fulfill({ contentType: "text/html", body: '<div id="probe"></div>' }));
  try {
    await page.goto(`${url}/clock-probe`);
    await page.clock.install({ time: new Date("2026-11-05T12:00:00") });
    await page.evaluate(async () => {
      const { createElement: h, createRoot } = await import("/test-harness");
      const { useCreatedAtCutoff } = await import("/src/lib/card-sync.ts");
      const timers = new Set();
      const originalSet = window.setInterval, originalClear = window.clearInterval;
      window.setInterval = (...args) => { const id = originalSet(...args); timers.add(id); return id; };
      window.clearInterval = (id) => { timers.delete(id); originalClear(id); };
      window.__timers = timers;
      function Probe() { return h("span", null, String(useCreatedAtCutoff())); }
      window.__root = createRoot(document.getElementById("probe"));
      window.__root.render(h("div", null, h(Probe), h(Probe)));
    });
    await page.waitForFunction(() => document.querySelectorAll("span").length === 2);
    assert.equal(await page.evaluate(() => window.__timers.size), 0);
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(true));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => s.textContent !== "null"));
    assert.equal(await page.evaluate(() => window.__timers.size), 1);
    await page.clock.fastForward(12 * 60 * 60 * 1000 + 100);
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => +s.textContent === new Date().setHours(0, 0, 0, 0)));
    await page.clock.setSystemTime(new Date("2026-11-07T12:00:00"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => +s.textContent === new Date().setHours(0, 0, 0, 0)));
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(false));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => s.textContent === "null"));
    assert.equal(await page.evaluate(() => window.__timers.size), 0);
  } finally {
    await page.close();
  }
});

test("counts keep previous data during cutoff fetches and unkeyed schedules update", async () => {
  const page = await browser.newPage();
  page.on("pageerror", console.error);
  page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
  await page.route("**/counts-probe", (route) => route.fulfill({ contentType: "text/html", body: '<div id="probe"></div>' }));
  try {
    await page.goto(`${url}/counts-probe`);
    await page.evaluate(async () => {
      let callbacks = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++callbacks, unregisterCallback() {},
        invoke: async (command, args) => {
          if (command.startsWith("plugin:")) return callbacks;
          if (command === "due_counts") {
            if (args.createdAtCutoff !== null) return new Promise((resolve) => { window.__resolveCounts = resolve; });
            return [{ moduleId: "a", new: 3, learning: 0, review: 0, laterNew: 0, laterLearning: 0, laterReview: 0 }];
          }
          if (command === "card_schedules") return [{ id: "a", state: 0, createdAt: Date.now(), dueAt: 1, lastReviewAt: null }];
          return null;
        },
      };
      const { createElement: h, createRoot, QueryClient, QueryClientProvider } = await import("/test-harness");
      const { useDueCounts, useCardSchedules } = await import("/src/lib/card-sync.ts");
      window.__schedules = [];
      const editor = { commands: { setCardSchedules: (cards) => window.__schedules.push(cards) } };
      function Probe() {
        useCardSchedules(editor, "a", true);
        return h("span", null, String(useDueCounts().total.new));
      }
      createRoot(document.getElementById("probe")).render(h(QueryClientProvider, { client: new QueryClient() }, h(Probe)));
    });
    await page.waitForFunction(() => document.querySelector("span")?.textContent === "3" && window.__schedules.length > 0);
    assert.equal(await page.evaluate(() => window.__schedules.at(-1)[0].dueAt), 1);
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(true));
    await page.waitForFunction(() => window.__resolveCounts && window.__schedules.at(-1)[0].dueAt > Date.now());
    assert.equal(await page.locator("span").textContent(), "3");
    await page.evaluate(() => window.__resolveCounts([{ moduleId: "a", new: 1, learning: 0, review: 0, laterNew: 2, laterLearning: 0, laterReview: 0 }]));
    await page.waitForFunction(() => document.querySelector("span")?.textContent === "1");
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(false));
    await page.waitForFunction(() => window.__schedules.at(-1)[0].dueAt === 1);
  } finally {
    await page.close();
  }
});
