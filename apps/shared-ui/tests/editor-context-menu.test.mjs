import { browserHarness, waitForEditorSelection } from "./support/browser.mjs";
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
  // Resize/scroll dismisses an open menu; finish editor layout before opening it.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

// Skipped on CI only: on the macOS runner the bubble menu's Copy button sometimes never
// becomes "stable" and the click times out after 30s. It still runs on every dev machine.

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

for (const kind of ['blockquote', 'bulletList', 'details']) {
  test(`Enter accepts the highlighted slash item inside ${kind}`, async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fresh();
    await page.evaluate(kind => {
      const line = { type: 'paragraph' };
      const block = kind === 'details'
        ? { type: kind, attrs: { open: true }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Title' }] }, { type: 'detailsContent', content: [line] }] }
        : kind === 'bulletList' ? { type: kind, content: [{ type: 'listItem', content: [line] }] }
        : { type: kind, content: [line] };
      editor.commands.setContent({ type: 'doc', content: [block] });
      let pos;
      editor.state.doc.descendants((node, offset) => { if (node.type.name === 'paragraph' && pos === undefined) pos = offset + 1; });
      editor.commands.setTextSelection(pos);
      editor.view.focus();
    }, kind);
    if (kind === 'details') await page.locator('[data-type="detailsContent"] p').click();
    await waitForEditorSelection(page);
    await page.keyboard.type('/code');
    await page.getByRole('option', { name: /^Code block/ }).waitFor();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('option', { name: /^Code block/ }).count(), 0);
    assert.equal(await page.evaluate(() => editor.state.selection.$head.parent.type.name), 'codeBlock');
    assert.equal(await page.evaluate(() => editor.state.doc.textContent.includes('/code')), false);
    // Code insertion may legitimately lift a list; acceptance is the contract.
    assert.equal(await page.locator('.tiptap pre').count(), 1);
  });
}

test('Enter gives a custom-key mention suggestion priority over list splitting', async () => {
  await fresh();
  await page.evaluate(async () => {
    const { default: Suggestion } = await import('/node_modules/@tiptap/suggestion/dist/index.js');
    const { PluginKey } = await import('/node_modules/@tiptap/pm/state/index.js');
    editor.commands.setContent('<ul><li><p></p></li></ul>');
    editor.commands.setTextSelection(3);
    editor.registerPlugin(Suggestion({
      editor, pluginKey: new PluginKey('review-mention'), char: '@',
      render: () => ({ onKeyDown: ({ event, range }) => {
        if (event.key !== 'Enter') return false;
        return editor.commands.insertContentAt(range, 'Mention accepted');
      } }),
    }));
    editor.view.focus();
  });
  await page.keyboard.type('@person');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => editor.state.doc.firstChild.textContent), 'Mention accepted');
  assert.equal(await page.evaluate(() => editor.state.doc.firstChild.childCount), 1);
});
