import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("desktop toolbar spacing and Settings back navigation respect the platform and history", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const origin = `http://localhost:${server.httpServer.address().port}`;
    for (const platform of ["Win32", "Linux x86_64", "MacIntel"]) {
      for (const fullscreen of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        const setup = ({ platform, fullscreen }) => {
          Object.defineProperty(navigator, "platform", { value: platform });
          Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
          Object.defineProperty(navigator, "userAgent", { value: platform });
          window.installTestBridge({ tauri: { invoke: async (command, args) => {
            if (command === "plugin:window|is_fullscreen") return fullscreen;
            if (command.startsWith("plugin:")) return 1;
            if (command === "modules") return [{ id: "m1", name: "Algebra", heading_numbering: false }];
            if (command === "get_content") return { state: [], updates: [], files: [] };
            if (command === "add_update") return { id: 1, bytes: args.bytes };
            return [];
          } } });
        };
        await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})(${JSON.stringify({ platform, fullscreen })});`);
        await page.goto(`${origin}/m1`);
        await page.locator(".tiptap[contenteditable=true]").waitFor();
        const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
        const expectedLeft = platform === "MacIntel" && !fullscreen ? 80 : 8;
        for (const collapsed of [false, true]) {
          if (collapsed) await toggle.click();
          await page.waitForFunction(expected => {
            const toggle = document.querySelector('button[aria-label="Toggle sidebar"]');
            return toggle?.getBoundingClientRect().x === expected;
          }, expectedLeft);
          assert.equal((await toggle.boundingBox()).x, expectedLeft, `${platform}, fullscreen=${fullscreen}, collapsed=${collapsed}`);
        }
        await toggle.click();
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.waitForURL(`${origin}/m1`);
        await page.locator(".tiptap[contenteditable=true]").waitFor();
        await page.close();
      }
    }
    // A direct launch has no previous app route, so Back goes home.
    const direct = await browser.newPage();
    await direct.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async () => [] } });`);
    await direct.goto(`${origin}/settings`);
    await direct.getByRole("button", { name: "Back", exact: true }).click();
    await direct.waitForURL(`${origin}/`);
    await direct.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});


test("long breadcrumbs remain within the desktop header", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Computer Architecture and Concurrency ".repeat(12), heading_numbering: false }];
        if (command === "get_content") return { state: [], updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        return [];
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
    await page.locator(".tiptap[contenteditable=true]").waitFor();
    for (const width of [1280, 850, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.waitForTimeout(400);
        const box = await page.evaluate(() => {
          const h = document.querySelector("header").getBoundingClientRect();
          const c = document.querySelector('[data-slot="breadcrumb-list"]').getBoundingClientRect();
          return { top: c.top, bottom: c.bottom, ht: h.top, hb: h.bottom, height: h.height };
        });
        assert.equal(box.height, 32);
        assert.ok(box.top >= box.ht && box.bottom <= box.hb, JSON.stringify(box));
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
