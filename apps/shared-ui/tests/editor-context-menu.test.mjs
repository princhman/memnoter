import { browserHarness } from "./support/browser.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

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
const filter = () => page.getByRole("combobox", { name: "Filter insert commands" });
async function fresh() {
  await page.evaluate(() => {
    editor.view.dom.removeAttribute("data-native-editor");
    editor.setEditable(true);
    editor.commands.setContent("<p>first paragraph</p><p>second paragraph</p>");
    editor.commands.setTextSelection(1);
    editor.view.focus();
  });
}
async function openAt(pos) {
  const point = await page.evaluate(pos => {
    const rect = editor.view.coordsAtPos(pos);
    return { x: rect.left + 1, y: rect.top + 3 };
  }, pos);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

test("right click moves the caret, filters without editing, and inserts without a slash", async () => {
  await fresh();
  await page.evaluate(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  await openAt(20);
  await filter().waitFor();
  const caret = await page.evaluate(() => editor.state.selection.head);
  assert.ok(caret >= 18);
  await page.keyboard.type("quote");
  assert.equal(await page.evaluate(() => editor.state.doc.textContent), "first paragraphsecond paragraph");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await filter().count(), 0);
  assert.equal(await page.evaluate(() => editor.state.doc.child(1).type.name), "blockquote");
  assert.equal(await page.evaluate(() => editor.state.doc.textContent), "first paragraphsecond paragraph");
});

test("right clicking within a selection retains it, copying and cutting use native editor events", async () => {
  await fresh();
  await page.evaluate(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  await openAt(3);
  await filter().waitFor();
  assert.deepEqual(await page.evaluate(() => ({ from: editor.state.selection.from, to: editor.state.selection.to })), { from: 1, to: 6 });
  await page.evaluate(() => document.addEventListener("copy", event => {
    window.copied = { text: event.clipboardData.getData("text/plain"), html: event.clipboardData.getData("text/html") };
  }, { once: true }));
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copied.text), "first");
  assert.match(await page.evaluate(() => window.copied.html), /first/);
  assert.equal(await filter().count(), 0);
  assert.equal(await page.evaluate(() => editor.state.doc.textContent), "first paragraphsecond paragraph");
  await openAt(3);
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  assert.equal(await page.evaluate(() => editor.state.doc.textContent), " paragraphsecond paragraph");
});

test("Escape, outside click, and document changes dismiss the menu", async () => {
  await fresh();
  await openAt(4);
  await filter().waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await filter().count(), 0);
  assert.equal(await page.evaluate(() => editor.view.hasFocus()), true);
  await openAt(4);
  await filter().waitFor();
  await page.mouse.click(5, 5);
  assert.equal(await filter().count(), 0);
  await openAt(4);
  await filter().waitFor();
  await page.evaluate(() => editor.commands.insertContent("changed"));
  assert.equal(await filter().count(), 0);
});

test("right click reuses contextual table actions and slash still works", async () => {
  await fresh();
  await openAt(4);
  await filter().fill("table");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".tiptap table").count(), 1);
  const pos = await page.evaluate(() => editor.state.selection.head);
  await openAt(pos);
  await filter().fill("row below");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".tiptap tr").count(), 4);
  await fresh();
  await page.keyboard.type("/h1");
  await page.getByRole("option", { name: /^Heading 1/ }).waitFor();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => editor.state.doc.child(0).type.name), "heading", JSON.stringify(await page.evaluate(() => editor.getJSON())));
  assert.equal(await page.evaluate(() => editor.state.doc.textContent.includes("/")), false);
});

test("native iOS host and read-only editors keep their native context menu", async () => {
  await fresh();
  await page.evaluate(() => editor.view.dom.setAttribute("data-native-editor", "true"));
  await openAt(4);
  assert.equal(await filter().count(), 0);
  await page.evaluate(() => { editor.view.dom.removeAttribute("data-native-editor"); editor.setEditable(false); });
  await openAt(4);
  assert.equal(await filter().count(), 0);
});

test("the menu fits a small viewport and handles an empty filter result", async () => {
  await page.setViewportSize({ width: 320, height: 240 });
  await fresh();
  await openAt(4);
  await filter().waitFor();
  await page.waitForFunction(() => {
    const bounds = document.querySelector("[data-editor-context-menu]")?.getBoundingClientRect();
    return bounds && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  });
  await filter().fill("no-command-matches-this");
  await page.getByText("No matching commands", { exact: true }).waitFor();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => editor.state.doc.textContent), "first paragraphsecond paragraph");
  await page.keyboard.press("Escape");
  assert.equal(await filter().count(), 0);
});

test("opening near the viewport edge keeps the page still and Copy available", async () => {
  await page.setViewportSize({ width: 320, height: 240 });
  await fresh();
  await page.evaluate(() => {
    editor.commands.setContent("<p>some paragraph text</p>".repeat(30));
    const pos = editor.state.doc.content.size - editor.state.doc.lastChild.nodeSize + 1;
    editor.commands.setTextSelection({ from: pos, to: pos + 4 });
    editor.view.dom.lastElementChild.scrollIntoView({ block: "end" });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pos = await page.evaluate(() => editor.state.selection.from + 1);
  const scroll = await page.evaluate(() => [scrollX, scrollY]);
  await openAt(pos);
  await filter().waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), scroll);
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
  const selected = await page.getByRole("option", { selected: true }).boundingBox();
  const copy = await page.getByRole("button", { name: "Copy", exact: true }).boundingBox();
  assert.ok(selected.y >= 0 && selected.y + selected.height <= 240);
  assert.ok(copy.y >= 0 && copy.y + copy.height <= 240);
  assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), scroll);
  await page.keyboard.press("Escape");
});
