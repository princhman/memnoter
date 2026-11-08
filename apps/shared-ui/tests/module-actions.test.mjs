import { browserHarness } from "./support/browser.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);
test("module actions open from right-click and keyboard, reuse dialogs and review the selected module", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/modules.html`);
    const row = page.getByRole("link", { name: "Algebra", exact: true });
    await page.getByRole("button", { name: "Actions for Algebra" }).hover();
    await page.getByRole("button", { name: "Actions for Algebra" }).focus();
    await page.getByRole("tooltip").filter({ hasText: "Shift+F10" }).waitFor();
    const rowBox = await row.boundingBox();
    const point = { x: rowBox.x + 30, y: rowBox.y + rowBox.height / 2 };
    await page.mouse.click(point.x, point.y, { button: "right" });
    const contextMenu = page.getByRole("menu");
    await contextMenu.waitFor();
    const menuBox = await contextMenu.boundingBox();
    // Opens at the pointer, as a context menu, not anchored to the "…" button.
    assert.ok(Math.abs(menuBox.x - point.x) <= 8 && Math.abs(menuBox.y - point.y) <= 8, `menu at pointer: ${JSON.stringify({ point, menuBox })}`);
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("dialog", { name: "Rename module" }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.focus(); await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete module?" }).waitFor();
    assert.equal((await page.evaluate(() => calls)).some(call => call.command === "delete_module"), false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Actions for Algebra" }).click();
    assert.equal(await page.getByRole("menuitem", { name: /chapter numbering/i }).count(), 0);
    await page.getByRole("menuitem", { name: "Review", exact: true }).click();
    await page.waitForURL("**/review?module=algebra");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const numbering = page.getByRole("switch", { name: "Algebra" });
    assert.equal(await numbering.getAttribute("aria-checked"), "false");
    await numbering.click();
    await page.waitForFunction(() => calls.some(call => call.command === "set_module_numbering" && call.args.enabled === true));
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tooltips.html`);
    await page.getByRole("button", { name: "Rectangle", exact: true }).hover();
    const tooltip = page.getByRole("tooltip", { name: "Rectangle R", exact: true });
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /Rectangle.*R/s);
    assert.equal(await tooltip.evaluate(element => !!element.closest("dialog, [role=dialog]")), true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  } finally { await browser?.close(); await server.close(); }
});
