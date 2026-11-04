// Card text without an id gets one when its note loads, either opened or
// checked in the background. That id must be saved into the note, or every
// launch makes a new card and the old one loses its review history. Runs the
// app in WebKit against a fake Tauri backend that keeps saves in memory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";
import * as Y from "yjs";

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
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callbacks,
      unregisterCallback() {},
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command, args) => {
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
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
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
