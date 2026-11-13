import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHarness } from "./support/browser.mjs";
const { createServer, webkit } = browserHarness(import.meta.url);

test("palette drills into a closed module and opens a heading with its caret", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      window.saved = [];
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Algebra", heading_numbering: false }, { id: "m2", name: "Empty module", heading_numbering: false }];
        if (command === "get_content") return { state: args.moduleId === "m1" ? window.saved : [], updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        return [];
      } } });
    });
    const origin = `http://localhost:${server.httpServer.address().port}`;
    await page.goto(`${origin}/m2`);
    await page.locator(".tiptap[contenteditable=true]").waitFor();
    await page.evaluate(async () => {
      const { paletteContent } = await import("/tests/browser/palette-content.js");
      window.saved = await paletteContent();
    });
    const input = page.getByRole("combobox", { name: "Search modules and commands" });
    const options = page.getByRole("option");
    await page.keyboard.press("Meta+k");
    await options.filter({ hasText: "Algebra" }).hover();
    await input.press("Meta+Enter");
    await options.filter({ hasText: "Foundations" }).waitFor();
    assert.deepEqual(await options.allTextContents(), ["Foundations", "Geometry"]);
    assert.ok(page.url().endsWith("/m2"));
    await input.press("ArrowRight");
    await options.filter({ hasText: "Numbers" }).waitFor();
    assert.deepEqual(await options.allTextContents(), ["Numbers", "Equations"]);
    await input.press("Meta+Enter");
    await options.filter({ hasText: "Integers" }).waitFor();
    await input.press("Backspace");
    await options.filter({ hasText: "Numbers" }).waitFor();
    await input.press("ArrowLeft");
    await options.filter({ hasText: "Geometry" }).waitFor();
    await input.fill("Integers");
    await options.filter({ hasText: "Integers" }).waitFor();
    assert.equal(await options.count(), 1);
    await input.press("Enter");
    await page.waitForURL(`${origin}/m1`);
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const selection = window.getSelection();
      return selection?.isCollapsed && selection.anchorNode?.parentElement?.closest("h3")?.textContent === "Integers";
    });
    const box = await page.locator(".tiptap h3").filter({ hasText: "Integers" }).boundingBox();
    assert.ok(box.y >= 0 && box.y < 700, `target visible: ${box.y}`);
    // The live editor outline follows the same path; also show its dark appearance.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.keyboard.press("Meta+k");
    await options.filter({ hasText: "Algebra" }).hover();
    await input.press("Meta+Enter");
    await options.filter({ hasText: "Geometry" }).waitFor();
    await input.fill("Geometry");
    await input.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => window.getSelection()?.anchorNode?.parentElement?.closest("h1")?.textContent === "Geometry");
    await page.keyboard.press("Meta+k");
    await options.filter({ hasText: "Empty module" }).hover();
    await input.press("ArrowRight");
    await page.getByText("No headings", { exact: true }).waitFor();
    await input.press("ArrowLeft");
    await options.filter({ hasText: "Empty module" }).hover();
    await input.press("Enter");
    await page.waitForURL(`${origin}/m2`);
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.close();
  } finally { await browser?.close(); await server.close(); }
});
