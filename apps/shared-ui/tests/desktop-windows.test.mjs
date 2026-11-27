import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("desktop windows show each other's saved edits and converge after concurrent typing", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const origin = `http://localhost:${server.httpServer.address().port}`;
    const browser = await webkit.launch();
    const context = await browser.newContext({ viewport: { width: 1000, height: 660 } });
    const moduleId = "737989f6-8649-4de5-bc1f-64723df5431c";
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Shared note");
    paragraph.insert(0, [text]);
    doc.getXmlFragment("default").insert(0, [paragraph]);
    const state = Array.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();

    const updates = [];
    const openings = [];
    const pages = new Set();
    let holdPeerEvents = false;
    const pendingEvents = [];
    const emit = (target, event, payload) => target.evaluate(({ event, payload }) => {
      window.deliverTauriEvent(event, payload);
    }, { event, payload });
    await context.exposeBinding("desktopCommand", async ({ page }, command, args) => {
      switch (command) {
        case "modules":
          return [{ id: moduleId, name: "Algebra", heading_numbering: false }];
        case "sidebar_items":
          return [{ kind: "module", id: moduleId }];
        case "get_content":
          return { state, updates, files: [] };
        case "open_window": {
          openings.push(args.moduleId ?? null);
          const label = `note-${openings.length}`;
          const next = await context.newPage();
          pages.add(next);
          await next.addInitScript(({ label, openedModule }) => {
            window.testWindowLabel = label;
            window.__memnoterInitialModule = openedModule;
          }, { label, openedModule: args.moduleId ?? null });
          await next.goto(origin, { waitUntil: "commit" });
          return;
        }
        case "add_update": {
          const update = { id: updates.length + 1, bytes: args.bytes };
          updates.push(update);
          const publish = () => Promise.all([...pages].filter(peer => peer !== page).map(peer =>
            emit(peer, "note-update-saved", { moduleId: args.moduleId, update })));
          if (holdPeerEvents) pendingEvents.push(publish);
          else await publish();
          return update;
        }
        case "sync_status":
          return { generation: "test", account: null };
        default:
          return [];
      }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "Win32" });
      const callbacks = new Map();
      const listeners = new Map();
      window.deliverTauriEvent = (event, payload) => {
        for (const [id, name] of listeners) {
          if (name === event) callbacks.get(id)?.({ event, id, payload });
        }
      };
      window.installTestBridge({ tauri: {
        transformCallback(handler) {
          const id = callbacks.size + 1;
          callbacks.set(id, handler);
          return id;
        },
        invoke(command, args) {
          if (command === "plugin:event|listen") {
            listeners.set(args.handler, args.event);
            return Promise.resolve(args.handler);
          }
          if (command === "plugin:event|unlisten") {
            listeners.delete(args.eventId);
            return Promise.resolve();
          }
          return window.desktopCommand(command, args);
        },
      } });
      // The bridge copies its configuration before per-window initialization.
      Object.defineProperty(window.__TAURI_INTERNALS__, "metadata", {
        get() {
          const label = window.testWindowLabel ?? "main";
          return { currentWindow: { label }, currentWebview: { label } };
        },
      });
    });
    const main = await context.newPage();
    pages.add(main);
    await main.goto(`${origin}/${moduleId}`);
    const selector = '.tiptap[contenteditable="true"]';
    const editor = page => page.locator(selector);
    const waitForText = (page, text) => page.waitForFunction(
      ({ selector, text }) => document.querySelector(selector)?.textContent === text, { selector, text });

    await waitForText(main, "Shared note");

    let open = context.waitForEvent("page");
    await main.getByRole("link", { name: "Algebra", exact: true }).click({ button: "right" });
    await main.getByRole("menuitem", { name: "Open in new window" }).click();
    const peer = await open;
    await waitForText(peer, "Shared note");
    assert.deepEqual(openings, [moduleId]);

    const settle = async () => {
      if (process.env.PROOF_DIR) await delay(1000);
    };
    await settle();
    await editor(main).click();
    await main.keyboard.press("End");
    await main.keyboard.type(" from A", { delay: process.env.PROOF_DIR ? 75 : 0 });
    await waitForText(peer, "Shared note from A");
    await settle();

    holdPeerEvents = true;
    await editor(main).click();
    await main.keyboard.press("Home");
    await main.keyboard.insertText("Left: ");
    await editor(peer).click();
    await peer.keyboard.press("End");
    await peer.keyboard.insertText(" + right");
    await waitForText(main, "Left: Shared note from A");
    await waitForText(peer, "Shared note from A + right");
    for (let attempt = 0; pendingEvents.length < 2 && attempt < 100; attempt++) await delay(20);
    assert.equal(pendingEvents.length, 2);
    const locallySaved = updates.length;
    for (const publish of pendingEvents.splice(0).reverse()) await publish();
    holdPeerEvents = false;
    for (const page of [main, peer]) await waitForText(page, "Left: Shared note from A + right");
    await settle();
    assert.equal(updates.length, locallySaved, "peer edits must not be saved back again");

    await main.keyboard.press("Control+k");
    await main.getByRole("option").filter({ hasText: "Algebra" }).waitFor();
    await main.getByRole("button", { name: /Actions/ }).click();
    open = context.waitForEvent("page");
    await main.getByRole("menuitem", { name: "Open in new window" }).click();
    const palettePeer = await open;
    await waitForText(palettePeer, "Left: Shared note from A + right");
    assert.deepEqual(openings, [moduleId, moduleId]);

    open = context.waitForEvent("page");
    await main.keyboard.press("Control+Shift+n");
    const blank = await open;
    await blank.getByRole("heading", { name: "Memnoter" }).waitFor();
    await waitForText(main, "Left: Shared note from A + right");
    assert.deepEqual(openings, [moduleId, moduleId, null]);
    await context.close();
  } finally {
    await server.close();
  }
});
