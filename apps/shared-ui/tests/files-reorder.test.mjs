import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("a pointer drop in Files moves the row to the indicated edge and keeps Files open", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1040, height: 660 } });
    const modules = [{ id: "algebra", name: "Algebra" }, { id: "geometry", name: "Geometry" }];
    const file = (id, name, module, pageCount) => ({
      id, name: name + ".pdf", moduleId: module.id, moduleName: module.name,
      size: 1000, pageCount, available: true,
    });
    const first = file("first", "Lecture notes", modules[0], 18);
    const second = file("second", "Problem set", modules[1], 6);
    const third = file("third", "Exam review", modules[0], 12);
    let documents = [first, second, third];
    const moves = [];
    await page.route("**/files-test-core", async route => {
      const { command, args } = route.request().postDataJSON();
      if (command === "move_document") {
        moves.push(args);
        documents = [third, first, second];
      }
      const result = command === "modules" ? modules
        : command === "list_documents" ? documents
        : command.startsWith("plugin:") ? 0
        : ["sidebar_items", "due_counts", "unindexed_card_modules", "unindexed_modules"].includes(command) ? []
        : null;
      await route.fulfill({ json: result });
    });
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        const response = await fetch("/files-test-core", { method: "POST", body: JSON.stringify({ command, args }) });
        return response.json();
      } } });
    });
    const url = `http://localhost:${server.httpServer.address().port}/files`;
    const pause = async () => { if (process.env.PROOF_DIR) await page.waitForTimeout(950); };
    await page.goto(url);
    const list = page.getByRole("list", { name: "Files", exact: true });
    const source = list.getByRole("link", { name: /Exam review/ });
    const target = list.getByRole("link", { name: /Lecture notes/ });
    await source.waitFor();
    await pause();
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    await page.mouse.move(from.x + 90, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 220, to.y + to.height / 4, { steps: 18 });
    const indicator = list.locator("li").filter({ has: page.getByRole("link", { name: /Lecture notes/ }) }).locator("[data-file-drop-indicator]");
    await indicator.waitFor();
    if (process.env.PROOF_DIR) {
      await pause();
      await page.screenshot({ path: `${process.env.PROOF_DIR}/drop-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.locator("html.dark").waitFor();
      await page.screenshot({ path: `${process.env.PROOF_DIR}/drop-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });
      await page.locator("html:not(.dark)").waitFor();
    }
    await page.mouse.up();
    await list.getByRole("link").first().filter({ hasText: "Exam review" }).waitFor();
    await pause();
    assert.deepEqual(moves, [{ id: "third", targetId: "first", after: false }]);
    assert.equal(new URL(page.url()).pathname.replace(/\/$/, ""), "/files");
    await page.reload();
    await list.getByRole("link").first().filter({ hasText: "Exam review" }).waitFor();
    await pause();
    await page.goto(`${url}?module=algebra`);
    await list.getByRole("link").first().filter({ hasText: "Exam review" }).waitFor();
    assert.equal(await list.getByRole("link").count(), 2);
    await pause();
    await page.close();
  } finally {
    await server.close();
  }
});
