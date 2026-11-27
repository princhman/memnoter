import { browserHarness } from "./support/browser.mjs";
// A grade still being written when the review switches module belongs to the
// old session: it must not put the old module's cards or undo history into
// the new one. Runs the app in WebKit against a fake Tauri backend.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

const root = fileURLToPath(new URL("..", import.meta.url));
let server, browser, url;

before(async () => {
  server = await createServer({
    root,
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
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
        if (command === "due_cards") return cards.filter((c) => !args.moduleId || c.moduleId === args.moduleId);
        // The grade's write waits until the test lets it finish.
        if (command === "review_card") return new Promise((resolve) => window.__grades.push(resolve));
        if (["list_documents", "due_counts", "unindexed_card_modules", "unindexed_modules", "search_notes", "card_schedules"].includes(command)) return [];
        return null;
      } } });

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
    window.__writes = [];
    let failedReads = 0;
    window.allowQueueReads = () => { failedReads = 0; };
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "a", name: "Alpha" }];
        if (command === "due_cards") {
          window.__loads++;
          if (failedReads > 0) {
            failedReads--;
            throw new Error("Queue read failed");
          }
          // Enabling skip removes the currently displayed new card too.
          return structuredClone(cards.filter((c) => c.dueAt <= args.now &&
            (args.createdAtCutoff == null || c.reps > 0)));
        }
        if (command === "card_schedules") return structuredClone(cards);
        if (command === "review_card" || command === "undo_review") {
          window.__writes.push(command);
          Object.assign(cards.find((c) => c.id === args.cardId), args.card ?? args.previous);
          if (command === "undo_review") failedReads = 1;
          else if (window.__writes.includes("undo_review") && window.__writes.length === 3) failedReads = Infinity;
        }
        if (["list_documents", "due_counts", "unindexed_card_modules", "unindexed_modules", "search_notes"].includes(command)) return [];
        return null;
      } } });

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
    await page.getByText("First", { exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
      assert.equal(await page.getByRole("alert").textContent({ timeout: 1000 }), null, "Undo should recover from the failed queue read");
      throw error;
    });
    assert.ok(await page.getByRole("button", { name: "Redo", exact: true }).isEnabled());
    await toggle(false);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor({ timeout: 5000 });
    assert.equal(await page.getByText("First", { exact: true }).count(), 0);
    await page.keyboard.press("Space");
    await page.keyboard.press("4");
    assert.deepEqual(await page.evaluate(() => window.__writes), ["review_card", "undo_review", "review_card"]);
    await page.evaluate(() => window.allowQueueReads());
    await retry.click();
    await page.getByText("Second", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__writes), ["review_card", "undo_review", "review_card"]);
    // Clicks, not Space and 4: Redo keeps focus, and Space skips a focused button.
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: /^Easy/ }).click();
    await page.getByText("You reviewed 2 cards.", { exact: true }).waitFor();
  } finally {
    await page.close();
  }
});

test("cutoff consumers update together across midnight and catch up after sleep", async () => {
  const page = await browser.newPage();
  await page.route("**/clock-probe", (route) => route.fulfill({ contentType: "text/html", body: '<div id="probe"></div>' }));
  try {
    await page.goto(`${url}/clock-probe`);
    await page.clock.install({ time: new Date("2026-11-05T12:00:00") });
    await page.evaluate(async () => {
      const { createElement: h, createRoot } = await import("/test-harness");
      const { useCreatedAtCutoff } = await import("/src/lib/card-sync.ts");
      function Probe() { return h("span", null, String(useCreatedAtCutoff())); }
      window.__root = createRoot(document.getElementById("probe"));
      window.__root.render(h("div", null, h(Probe), h(Probe)));
    });
    await page.waitForFunction(() => document.querySelectorAll("span").length === 2);
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(true));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => s.textContent !== "null"));
    await page.clock.fastForward(12 * 60 * 60 * 1000 + 100);
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => +s.textContent === new Date().setHours(0, 0, 0, 0)));
    await page.clock.setSystemTime(new Date("2026-11-07T12:00:00"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => +s.textContent === new Date().setHours(0, 0, 0, 0)));
    await page.evaluate(async () => (await import("/src/lib/store.ts")).setSkipCardsCreatedToday(false));
    await page.waitForFunction(() => [...document.querySelectorAll("span")].every((s) => s.textContent === "null"));
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
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
          if (command.startsWith("plugin:")) return callbacks;
          if (command === "due_counts") {
            if (args.createdAtCutoff !== null) return new Promise((resolve) => { window.__resolveCounts = resolve; });
            return [{ moduleId: "a", new: 3, learning: 0, review: 0, laterNew: 0, laterLearning: 0, laterReview: 0 }];
          }
          if (command === "card_schedules") return [{ id: "a", state: 0, createdAt: Date.now(), dueAt: 1, lastReviewAt: null }];
          return null;
        } } });
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

test("go to card selects its sentence in a long note; counts read learn / due / new", async () => {
  const Y = await import('yjs');
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, Array.from({ length: 75 }, (_, i) => {
    const block = new Y.XmlElement('paragraph'), text = new Y.XmlText();
    text.insert(0, i === 55 ? 'First {{Paris}} ' + 'A long paragraph before the target. '.repeat(650) + 'The capital of the UK is {{London}}! Another sentence follows.' : `Note paragraph ${i}`);
    block.insert(0, [text]);
    if (i === 55) block.setAttribute('cardId', 'target');
    return block;
  }));
  const state = [...Y.encodeStateAsUpdate(doc)];
  doc.destroy();
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    await page.addInitScript(({ state, theme }) => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith('plugin:')) return 1;
        if (command === 'modules') return [{ id: 'a', name: 'Geography' }];
        if (command === 'get_content') return { state, updates: [], files: [] };
        if (command === 'add_update') return { id: 1, bytes: args.bytes };
        if (command === 'due_counts') return [{ moduleId: 'a', count: 10, new: 5, learning: 2, review: 3, laterNew: 4, laterLearning: 6, laterReview: 7 }];
        if (command === 'due_cards') return [{
          id: 'target:c2', moduleId: 'a', moduleName: 'Geography', section: [], kind: 'cloze',
          front: [{ type: 'text', text: 'Go to the second cloze' }], back: [{ type: 'text', text: 'London' }],
          dueAt: Date.now() - 60000, stability: 0, difficulty: 0, scheduledDays: 0, learningStep: 0,
          state: 0, scheduleStatus: 'new', lastReviewAt: null, reps: 0, lapses: 0,
        }];
        return [];
      } } });
    }, { state, theme });
    try {
      await page.goto(`${url}/review`);
      await page.getByText('Go to the second cloze', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Edit card', exact: true }).count(), 0);
      const counts = page.locator('[aria-label="2 learn (+6 later today), 3 due (+7 later today), 5 new"]');
      await counts.first().waitFor();
      assert.equal((await counts.first().innerText()).replace(/\s/g, ''), '2+63+75');
      if (process.env.PROOF_DIR) {
        await page.screenshot({ path: `${process.env.PROOF_DIR}/PRI-316-${theme}.png` });
        await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
        await page.screenshot({ path: `${process.env.PROOF_DIR}/PRI-317-${theme}.png` });
      }
      await page.getByRole('button', { name: 'Go to card in note', exact: true }).click();
      await page.waitForURL(`${url}/a`);
      await page.waitForFunction(() => document.getSelection()?.toString() === 'The capital of the UK is {{London}}!');
      const geometry = await page.locator('[data-card-id="target"]').evaluate(node => {
        const scroll = node.closest('.app-scroll-container');
        const rect = document.getSelection().getRangeAt(0).getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewportTop: bounds.top, viewportBottom: bounds.bottom, scrollTop: scroll.scrollTop };
      });
      assert.ok(geometry.scrollTop > 0);
      assert.ok(geometry.top >= geometry.viewportTop && geometry.bottom <= geometry.viewportBottom);
      await page.getByRole('button', { name: 'Bold', exact: true }).click();
      await page.getByRole('button', { name: 'Bold', exact: true, pressed: true }).waitFor();
      if (process.env.PROOF_DIR) await page.screenshot({ path: `${process.env.PROOF_DIR}/PRI-343-${theme}.png` });
    } finally { await page.close(); }
  }
});

test('a list reveals each step before one grade, and undo restores one review', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const card = { id:'list', moduleId:'a', moduleName:'Alpha', section:[], kind:'basic', front:[{type:'text',text:'Name the phases'}], back:['Prophase','Metaphase','Anaphase'].map(text => ({type:'block',revealStep:true,children:[{type:'text',text}]})), dueAt:Date.now()-1000, stability:0, stabilityFast:0, difficulty:0, scheduledDays:0, learningStep:0, state:0, scheduleStatus:'new', lastReviewAt:null, reps:0, lapses:0, fsrsModel:null };
    window.writes = [];
    window.installTestBridge({tauri:{invoke: async (command,args) => {
      if (command.startsWith('plugin:')) return 1;
      if (command === 'due_cards') return [card];
      if (command === 'modules') return [{id:'a',name:'Alpha'}];
      if (command === 'review_card' || command === 'undo_review') window.writes.push(command);
      if (['list_documents','due_counts','unindexed_card_modules','unindexed_modules','search_notes','card_schedules'].includes(command)) return [];
      return null;
    }}});
  });
  try {
    await page.goto(`${url}/review?module=a`);
    await page.getByText('Name the phases').waitFor();
    for (const [index, text] of ['Prophase','Metaphase','Anaphase'].entries()) {
      assert.equal(await page.getByText(text,{exact:true}).count(),0);
      await page.keyboard.press('1');
      assert.deepEqual(await page.evaluate(() => window.writes),[]);
      await page.keyboard.press('Space');
      await page.getByText(text,{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes),[]);
      if (index < 2) assert.equal(await page.getByRole('button',{name:/^Good/}).count(),0);
    }
    await page.keyboard.press('3');
    await page.waitForFunction(() => window.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.writes),['review_card']);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await page.waitForFunction(() => window.writes.length === 2);
    assert.deepEqual(await page.evaluate(() => window.writes),['review_card','undo_review']);
    await page.getByText('Name the phases').waitFor();
    assert.equal(await page.getByText('Prophase',{exact:true}).count(),0);
  } finally { await page.close(); }
});

for (const scenario of ['deletion', 'schedule refresh']) {
  test(`review history follows ${scenario} outside the grade operation`, async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const card = (id, offset) => ({
          id, moduleId: 'a', moduleName: 'Alpha', section: [], kind: 'basic',
          front: [{ type: 'text', text: id }], back: [{ type: 'text', text: 'answer' }],
          dueAt: Date.now() + offset, stability: 0, stabilityFast: 0, difficulty: 0,
          scheduledDays: 0, learningStep: 0, state: 0, scheduleStatus: 'new',
          lastReviewAt: null, reps: 0, lapses: 0, fsrsModel: null,
        });
        const cards = [card('graded', -120_000), card('updated', -60_000)];
        window.changeCards = (scenario) => {
          if (scenario === 'deletion') cards.shift();
          else {
            cards[1].dueAt += 30_000;
            cards.push(card('added', -10_000));
          }
          return cards[1]?.dueAt;
        };
        window.installTestBridge({ tauri: { invoke: async (command, args) => {
          if (command === 'due_cards') return structuredClone(cards.filter(card => card.dueAt <= args.now));
          if (command === 'card_schedules') return structuredClone(cards);
          if (command === 'review_card' || command === 'undo_review') {
            const target = cards.find(card => card.id === args.cardId);
            if (!target) throw new Error('Card was deleted');
            Object.assign(target, args.card ?? args.previous);
          }
          return [];
        } } });
      });
      await page.goto(`${url}/review`);
      const result = await page.evaluate(async scenario => {
        const { ReviewSession } = await import('/src/lib/review-session.ts');
        const session = new ReviewSession();
        await session.load();
        session.reveal();
        await session.rate(4);
        const graded = session.getSnapshot();
        const updatedDue = window.changeCards(scenario);
        await session.load();
        const refreshed = session.getSnapshot();
        await session.undo();
        const undone = session.getSnapshot();
        await session.redo();
        return { graded, refreshed, undone, redone: session.getSnapshot(), updatedDue };
      }, scenario);
      assert.equal(result.graded.canUndo, true);
      assert.deepEqual(result.graded.queue.map(card => card.id), ['updated']);
      if (scenario === 'deletion') {
        assert.equal(result.refreshed.canUndo, false);
        assert.equal(result.undone.error, null);
      } else {
        for (const snapshot of [result.undone, result.redone]) {
          assert.ok(snapshot.queue.some(card => card.id === 'added'), 'card added by refresh stays queued');
          assert.equal(snapshot.queue.find(card => card.id === 'updated').dueAt, result.updatedDue);
        }
        assert.equal(result.undone.queue.find(card => card.id === 'graded').reps, 0);
        assert.equal(result.redone.queue.some(card => card.id === 'graded'), false);
      }
    } finally {
      await page.close();
    }
  });
}
