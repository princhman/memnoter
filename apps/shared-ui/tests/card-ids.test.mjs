import { browserHarness } from "./support/browser.mjs";
// Card text without an id gets one when its note loads, either opened or
// checked in the background. That id must be saved into the note, or every
// launch makes a new card and the old one loses its review history. Runs the
// app in WebKit against a fake Tauri backend that keeps saves in memory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const { createServer, webkit } = browserHarness(import.meta.url);

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

// A note with one basic card, written before cards had ids.
function noteWithoutIds() {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "Question :: answer");
  paragraph.insert(0, [text]);
  doc.getXmlFragment("default").insert(0, [paragraph]);
  return [{ id: 1, bytes: Array.from(Y.encodeStateAsUpdate(doc)) }];
}

// One app launch at `route`: returns what it saved and the cards it synced.
async function launch(route, updates) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript((updates) => {
    let callbacks = 0;
    window.__saved = [];
    window.__synced = [];
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "m1", name: "Demo" }];
        if (command === "get_content") return { state: [], updates, files: [] };
        if (command === "unindexed_card_modules") {
          return window.__synced.length ? [] : [{ id: "m1", name: "Demo" }];
        }
        if (command === "add_update") {
          window.__saved.push(args.bytes);
          return { id: 100 + window.__saved.length, bytes: args.bytes };
        }
        if (command === "sync_cards") {
          window.__synced.push(args.cards.map((card) => card.id));
          return [];
        }
        if (["due_counts", "due_cards", "search_notes", "unindexed_modules"].includes(command)) {
          return [];
        }
        return null;
      } } });

  }, updates);
  await page.goto(`${url}${route}`);
  await page.waitForFunction(() => window.__synced.length > 0);
  // Let any save that follows the sync land.
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    saved: window.__saved,
    synced: window.__synced.at(-1),
  }));
  await page.close();
  return result;
}

function savedCardId(updates) {
  const doc = new Y.Doc();
  for (const { bytes } of updates) Y.applyUpdate(doc, Uint8Array.from(bytes));
  return doc.getXmlFragment("default").get(0).getAttribute("cardId");
}

for (const [name, route] of [
  ["opening the note", "/m1"],
  ["the background check", "/"],
]) {
  test(`${name} saves the id it gives a card`, async () => {
    const updates = noteWithoutIds();
    const first = await launch(route, updates);
    assert.equal(first.synced.length, 1);
    for (const bytes of first.saved) updates.push({ id: updates.length + 1, bytes });
    assert.equal(savedCardId(updates), first.synced[0]);

    const second = await launch(route, updates);
    assert.deepEqual(second.synced, first.synced);
    assert.equal(second.saved.length, 0);
  });
}


test("the first cut paste keeps cloze history across and within notes, while copies are new", async () => {
  const workspace = fileURLToPath(new URL("../../..", import.meta.url));
  execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], {
    cwd: workspace, env: { ...process.env, CARGO_BUILD_JOBS: "4" }, stdio: "pipe",
  });
  const child = spawn(join(workspace, "target/debug/examples/command-harness"), [], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(child, "exit");
  const pending = [];
  createInterface({ input: child.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  const call = async (command, args = {}) => {
    const response = await new Promise(resolve => {
      pending.push(resolve);
      child.stdin.write(JSON.stringify({ command, args }) + "\n");
    });
    if (response.error) throw new Error(response.error.message ?? response.error);
    return response.value;
  };

  const page = await browser.newPage();
  let db;
  try {
    const source = await call("create_module", { name: "Geography" });
    const destination = await call("create_module", { name: "Travel" });
    db = new DatabaseSync(join(tmpdir(), `memnoter-harness-${child.pid}`, "main.db"), { readOnly: true });
    const log = db.prepare("select rating, review_time from review_log where card_id = ?");
    await page.exposeFunction("rustCall", (command, args) => {
      if (command.startsWith("plugin:") || command === "set_editor_history") return 1;
      return call(command, args);
    });
    await page.addInitScript(() => window.installTestBridge({ tauri: { invoke: (command, args) => window.rustCall(command, args) } }));
    const editor = page.locator('.tiptap[contenteditable="true"]');
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const schedules = async (moduleId, count) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const cards = await call("card_schedules", { moduleId });
        if (cards.length === count) return cards;
        await delay(50);
      }
      assert.fail(`Expected ${count} synced cards in ${moduleId}`);
    };

    await page.goto(`${url}/${source}`);
    await editor.click();
    await page.keyboard.type("{{Paris}} and {{France}}");
    await schedules(source, 2);
    const cards = await call("due_cards", { moduleId: source, now: Number.MAX_SAFE_INTEGER });
    const paris = cards.find(({ back }) => back.some(part => part.type === "cloze" && part.children.map(child => child.text).join("") === "Paris"));
    assert.ok(paris, JSON.stringify({ cards, text: await editor.textContent() }));
    const france = cards.find(card => card.id !== paris.id);
    await page.evaluate(async paris => {
      const { getScheduler, scheduleReview } = await import("/src/lib/fsrs.ts");
      const { card, log } = scheduleReview(await getScheduler(), paris, 4, Date.now());
      await window.rustCall("review_card", { cardId: paris.id, expectedReps: 0, card, log });
    }, paris);
    const initial = (await schedules(source, 2)).find(card => card.id === paris.id);
    const review = log.get(paris.id);
    assert.equal(review.rating, 4);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+x`);
    assert.equal(await editor.evaluate(el => el.editor.getText()), " and {{France}}");
    const [remaining] = await schedules(source, 1);
    assert.equal(remaining.id, france.id);

    await page.getByRole("link", { name: "Travel", exact: true }).click();
    await editor.click();
    await page.keyboard.press(`${mod}+v`);
    const [moved] = await schedules(destination, 1);
    assert.notEqual(moved.id, paris.id);
    assert.deepEqual(moved, { ...initial, id: moved.id });
    assert.deepEqual(log.get(moved.id), review);
    assert.equal(log.get(paris.id), undefined);

    await page.keyboard.press("End");
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const repeated = await schedules(destination, 2);
    assert.deepEqual(repeated.find(card => card.id === moved.id), moved);
    assert.equal(repeated.find(card => card.id !== moved.id).lastReviewAt, null);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+c`);
    await page.keyboard.press("End");
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const copied = await schedules(destination, 3);
    assert.deepEqual(copied.filter(card => card.lastReviewAt !== null), [moved]);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+x`);
    await schedules(destination, 2);
    await page.keyboard.press("End");
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const repasted = await schedules(destination, 3);
    const movedAgain = repasted.find(card => card.lastReviewAt !== null);
    assert.ok(movedAgain);
    assert.notEqual(movedAgain.id, moved.id);
    assert.deepEqual(movedAgain, { ...initial, id: movedAgain.id });
    assert.deepEqual(log.get(movedAgain.id), review);
    assert.deepEqual(repasted.filter(card => card.id !== movedAgain.id), copied.filter(card => card.id !== moved.id));
  } finally {
    db?.close();
    await page.close();
    child.stdin.end();
    await exit;
  }
});
