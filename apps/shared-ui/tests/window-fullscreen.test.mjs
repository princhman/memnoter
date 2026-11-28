import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("Windows toggles native full screen with F11 and from the palette", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "Win32" });
      window.fullscreenRequests = [];
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === "plugin:window|is_fullscreen") return window.fullscreenRequests.at(-1) ?? false;
        if (command === "plugin:window|set_fullscreen") {
          window.fullscreenRequests.push(args.value);
          return;
        }
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Algebra", heading_numbering: false }];
        if (command === "get_content") return { state: [], updates: [], files: [] };
        return [];
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`, { waitUntil: "commit" });
    const editor = page.locator(".tiptap[contenteditable=true]");
    await editor.click();
    const header = page.locator("header[data-tauri-drag-region]");
    const sidebarToggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
    const originalToggle = await sidebarToggle.boundingBox();
    assert.equal((await header.boundingBox()).y, 0);

    await page.keyboard.down("F11");
    await page.waitForFunction(() => window.fullscreenRequests.at(-1) === true, null, { timeout: 5000 });
    await page.keyboard.down("F11");
    await page.keyboard.up("F11");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal((await header.boundingBox()).y, 0);
    assert.deepEqual(await sidebarToggle.boundingBox(), originalToggle);
    assert.deepEqual(await page.evaluate(() => window.fullscreenRequests), [true]);

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search modules and commands" }).fill("fullscreen");
    const command = page.getByRole("option").filter({ hasText: "Full screen" });
    assert.match(await command.innerText(), /F11/);
    await command.click();
    await page.waitForFunction(() => window.fullscreenRequests.at(-1) === false);
    await page.setViewportSize({ width: 1100, height: 720 });
    assert.equal((await header.boundingBox()).y, 0);
    assert.deepEqual(await sidebarToggle.boundingBox(), originalToggle);
    assert.deepEqual(await page.evaluate(() => window.fullscreenRequests), [true, false]);
  } finally { await server.close(); }
});
