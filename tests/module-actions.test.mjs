import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";
test("module actions open from right-click and keyboard, reuse dialogs and review the selected module", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/modules.html`);
    const row = page.getByRole("link", { name: "Algebra", exact: true });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("dialog", { name: "Rename module" }).waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.focus(); await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog", { name: "Delete module?" }).waitFor();
    assert.equal((await page.evaluate(() => calls)).some(call => call.command === "delete_module"), false);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Actions for Algebra" }).click();
    await page.getByRole("menuitem", { name: "Enable chapter numbering" }).click();
    await page.getByRole("button", { name: "Actions for Algebra" }).click();
    await page.getByRole("menuitem", { name: "Disable chapter numbering" }).waitFor();
    await page.getByRole("menuitem", { name: "Review", exact: true }).click();
    await page.waitForURL("**/review?module=algebra");
  } finally { await browser?.close(); await server.close(); }
});
