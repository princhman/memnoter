import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

// Exercise the actual drag listener shipped by our locked Tauri Rust runtime,
// not a test copy of its clickable-element and double-click rules.
test("the entire top bar drags while controls and overlays remain interactive", async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const lock = await readFile(join(root, "../../Cargo.lock"), "utf8");
  const version = lock.match(/name = "tauri"\nversion = "([^"]+)"/)[1];
  const registry = join(homedir(), ".cargo/registry/src");
  let dragScript;
  try {
    for (const source of await readdir(registry)) {
      try { dragScript = await readFile(join(registry, source, `tauri-${version}/src/window/scripts/drag.js`), "utf8"); break; } catch {}
    }
  } catch {}
  if (!dragScript) { t.skip("Run cargo fetch to install the locked Tauri drag listener"); return; }
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    for (const fullscreen of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.addInitScript(fullscreen => {
        window.__windowCalls = [];
        let callback = 0;
        window.installTestBridge({ tauri: { invoke: async (command, args) => {
            window.__windowCalls.push(command);
            if (command === "plugin:window|is_fullscreen") return fullscreen;
            if (command.startsWith("plugin:")) return callback;
            if (command === "modules") return [{ id: "m1", name: "Algebra", heading_numbering: false }];
            if (command === "get_content") return { state: [], updates: [], files: [] };
            if (command === "add_update") return { id: 1, bytes: args.bytes };
            return [];
          } } });

      }, fullscreen);
      await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
      await page.locator(".tiptap[contenteditable=true]").waitFor();
      await page.addScriptTag({ content: dragScript.replace("__TEMPLATE_os_name__", "'macos'") });
      for (const collapsed of [false, true]) {
        if (collapsed) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("header").getBoundingClientRect().height === 32);
        const checked = await page.evaluate(() => {
          let count = 0;
          for (const x of [4, 76, 135, 200, 270, 480, 750, 990]) for (const y of [2, 16, 29]) {
            const element = document.elementFromPoint(x, y);
            if (element.closest("button, a, input, [role=button]")) continue;
            window.__windowCalls = [];
            element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, button: 0, detail: 1, clientX: x, clientY: y }));
            if (!window.__windowCalls.includes("plugin:window|start_dragging")) throw new Error(`No drag at ${x},${y}: ${element.outerHTML}`);
            count++;
          }
          return count;
        });
        assert.ok(checked >= 10);
      }
      await page.evaluate(() => { window.__windowCalls = []; });
      await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      assert.equal(await page.evaluate(() => __windowCalls.includes("plugin:window|start_dragging")), false);
      const header = page.locator("header");
      await header.dispatchEvent("mousedown", { bubbles: true, button: 0, detail: 2, clientX: 900, clientY: 12 });
      await header.dispatchEvent("mouseup", { bubbles: true, button: 0, detail: 2, clientX: 900, clientY: 12 });
      assert.equal(await page.evaluate(() => __windowCalls.includes("plugin:window|internal_toggle_maximize")), true);
      // There is no positioned drag overlay to intercept the editor's find UI.
      await page.locator(".tiptap").click();
      // AppKit routes Find through the menu event on this Tauri host.
      await page.evaluate(async () => {
        const { requestApp, FIND_EVENT } = await import("/src/lib/app-events.ts");
        requestApp(FIND_EVENT);
      });
      const find = page.getByRole("textbox", { name: "Find", exact: true });
      await find.fill("Hello");
      assert.equal(await find.inputValue(), "Hello");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+k");
      const palette = page.getByRole("combobox", { name: "Search modules and commands" });
      await palette.fill("Algebra");
      assert.equal(await palette.inputValue(), "Algebra");
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 40;
        document.querySelector(".tiptap").editor.commands.insertContent({ type: "image", attrs: { src: canvas.toDataURL(), alt: "Drag-area preview" } });
      });
      const image = page.locator(".note-image-host img");
      await image.waitFor(); await image.dblclick();
      const viewer = page.getByRole("dialog", { name: "Image preview" });
      await viewer.waitFor();
      await page.evaluate(() => { window.__windowCalls = []; });
      await viewer.dispatchEvent("mousedown", { bubbles: true, button: 0, detail: 1, clientX: 500, clientY: 12 });
      const close = viewer.getByRole("button", { name: "Close", exact: true });
      assert.equal(await close.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true);
      await close.click(); await viewer.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => __windowCalls.includes("plugin:window|start_dragging")), false);
      await page.close();
    }
  } finally { await browser?.close(); await server.close(); }
});
