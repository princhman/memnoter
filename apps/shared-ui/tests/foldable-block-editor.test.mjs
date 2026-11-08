import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, page;
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
  await page.waitForFunction(() => !!window.editor);
});
after(async () => { await browser?.close(); await server?.close(); });

test("a foldable block takes typing from its title down, Enter on its empty last line leaves it, and folding hides only it", async () => {
  // Give the page keyboard focus before typing.
  await page.locator(".tiptap").first().click();
  await page.evaluate(() => {
    editor.commands.setContent("<p></p>");
    editor.commands.focus();
    editor.commands.insertFoldableBlock();
  });
  await page.keyboard.type("Example");
  await page.keyboard.press("Enter");
  await page.keyboard.type("body");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after");
  const block = await page.evaluate(() => editor.getJSON().content.find(node => node.type === "details"));
  assert.equal(block.content[0].content[0].text, "Example");
  assert.deepEqual(block.content[1].content.map(line => line.content?.[0].text), ["body"]);
  await page.getByRole("button", { name: "Fold block" }).click();
  assert.equal(await page.evaluate(() => editor.getJSON().content.find(node => node.type === "details").attrs.open), false);
  assert.equal(await page.getByText("body", { exact: true }).isVisible(), false);
  assert.equal(await page.getByText("after", { exact: true }).isVisible(), true);
});
