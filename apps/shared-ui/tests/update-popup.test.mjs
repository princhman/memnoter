import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

// The rendered dialog owns dismissal, presentation throttling and priority.
// Transport tests already own detecting fatal/426 refusals; they cannot catch a
// banner, a lost Later action, repeated presentation, or an incorrect download.
test("update dialogs preserve local work, prioritize required updates and throttle optional presentation", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    let latest = "v99.0.0";
    await page.route("https://api.github.com/**", route => route.fulfill({ json: { tag_name: latest } }));
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === "plugin:opener|open_url") window.openedDownload = args.url;
      } } });
    });
    const url = `http://localhost:${server.httpServer.address().port}/tests/browser/update-popup.html`;
    await page.goto(url);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Update available", exact: true }).waitFor();
    if (process.env.PROOF_DIR) await page.waitForTimeout(1500);
    // Required supersedes an optional popup that is already open.
    await page.evaluate(() => window.refuseSync());
    await dialog.getByRole("heading", { name: "Memnoter needs an update to keep syncing", exact: true }).waitFor();
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      await dialog.getByRole("button", { name: "Download update", exact: true }).waitFor();
      if (process.env.PROOF_DIR) {
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `${process.env.PROOF_DIR}/required-${dark ? "dark" : "light"}.png` });
      }
    }
    await dialog.getByRole("button", { name: "Later", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("textbox", { name: "Local note" }).fill("Still working locally");
    await page.getByRole("button", { name: "Navigate", exact: true }).click();
    await page.evaluate(() => { window.refuseSync(); window.refuseSync(); });
    await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Local note" }).inputValue(), "Still working locally");

    // A fresh launch can show a required popup even if optional was shown today.
    await page.reload();
    await page.waitForFunction(() => window.refuseSync);
    await page.evaluate(() => window.refuseSync());
    await dialog.getByRole("heading", { name: "Memnoter needs an update to keep syncing", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Download update", exact: true }).click();
    await page.waitForFunction(() => window.openedDownload);
    assert.equal(await page.evaluate(() => window.openedDownload), "https://memnoter.com/#download");
    await dialog.waitFor({ state: "hidden" });

    // A different newer release inside the cached daily window must not reopen
    // optional UI. This catches throttling only the GitHub request, not the popup.
    await page.evaluate(() => {
      localStorage.setItem("memnoter-release-check", JSON.stringify({ checked: Date.now(), tag: "v99.0.1" }));
    });
    await page.reload();
    await page.getByRole("button", { name: "Navigate", exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await dialog.count(), 0);
    // Once the presentation window expires, another available release may show.
    latest = "v99.0.2";
    await page.evaluate(() => {
      localStorage.setItem("memnoter-release-popup-shown", String(Date.now() - 86_400_001));
      localStorage.removeItem("memnoter-release-check");
    });
    await page.reload();
    await dialog.getByRole("heading", { name: "Update available", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByRole("textbox", { name: "Local note" }).fill("Available after optional Later too");
    await context.close();
  } finally { await browser?.close(); await server.close(); }
});
