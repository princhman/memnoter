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
  page.on("pageerror", console.error);
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
  await page.waitForFunction(() => !!window.editor);
});
after(async () => { await browser?.close(); await server?.close(); });

async function fresh() {
  await page.evaluate(() => {
    editor.commands.setContent("<p></p>");
    editor.commands.focus();
  });
}
async function insert() {
  await fresh();
  await page.evaluate(() => execEditor(editor, "insertTable"));
}
async function cell(index, end = false) {
  await page.evaluate(({ index, end }) => {
    const cells = [];
    editor.state.doc.descendants((node, pos) => {
      if (["tableCell", "tableHeader"].includes(node.type.name)) cells.push({ node, pos });
    });
    const { node, pos } = cells[index];
    editor.commands.setTextSelection(pos + (end ? node.nodeSize - 2 : 2));
    editor.commands.focus();
  }, { index, end });
}
async function counts() {
  return page.evaluate(() => {
    const result = { table: 0, tableRow: 0, tableHeader: 0, tableCell: 0 };
    editor.state.doc.descendants(node => { if (node.type.name in result) result[node.type.name]++; });
    editor.state.doc.check();
    return result;
  });
}

test("slash insertion and contextual actions are scoped to tables", async () => {
  await fresh();
  await page.keyboard.type("/table");
  await page.getByRole("option", { name: /^Table 3/ }).waitFor();
  assert.equal(await page.getByRole("option", { name: "Add row below" }).count(), 0);
  await page.keyboard.press("Enter");
  assert.deepEqual(await counts(), { table: 1, tableRow: 3, tableHeader: 3, tableCell: 6 });
  await page.keyboard.type("/row");
  await page.getByRole("option", { name: "Add row below" }).click();
  assert.equal((await counts()).tableRow, 4);
});

test("Tab precedes prose spacing, Shift-Tab goes back, final Tab adds a row", async () => {
  await insert();
  await cell(0);
  const start = await page.evaluate(() => editor.state.selection.from);
  await page.keyboard.press("Tab");
  assert.ok(await page.evaluate(() => editor.state.selection.from) > start);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => editor.state.selection.from), start);
  await cell(8);
  await page.keyboard.press("Tab");
  assert.equal((await counts()).tableRow, 4);
  assert.equal(await page.evaluate(() => editor.state.doc.textContent.includes("\t")), false);
});

test("cell editing preserves table boundaries and note sections", async () => {
  await insert();
  await cell(0);
  await page.keyboard.type("alpha -> beta");
  assert.match(await page.evaluate(() => editor.state.doc.textContent), /alpha → beta/);
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.textContent), "second");
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Meta+Alt+1");
  assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.type.name), "paragraph");
  assert.equal(await page.evaluate(() => editor.commands.insertSection("sibling")), false);
  await cell(0);
  const before = await page.evaluate(() => editor.getJSON());
  await page.keyboard.press("Backspace");
  assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);
  assert.deepEqual(await counts(), { table: 1, tableRow: 3, tableHeader: 3, tableCell: 6 });
});

test("cell selection offers table actions while text in a cell keeps text formatting", async () => {
  await insert();
  await cell(0);
  await page.keyboard.type("select me");
  await page.evaluate(() => {
    const pos = editor.state.selection.from;
    editor.commands.setTextSelection({ from: pos - 9, to: pos });
  });
  await page.getByRole("button", { name: "Bold", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("toolbar", { name: "Table actions", exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(() => {
    const cells = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "tableHeader") cells.push(pos); });
    editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[1] });
  });
  await page.getByRole("button", { name: "Merge cells", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Bold", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Merge cells", exact: true }).click();
  assert.equal((await counts()).tableHeader, 2);
  await page.getByRole("button", { name: "Split cell", exact: true }).click();
  assert.equal((await counts()).tableHeader, 3);
});

test("edges appear on hover and caret, append at the end, and stay out of saved content", async () => {
  await fresh();
  await page.evaluate(() => {
    editor.commands.setContent('<p>outside</p><table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td><td><p>D</p></td></tr></table>');
    editor.commands.setTextSelection(1);
  });
  await page.mouse.move(700, 500);
  const row = page.getByRole("button", { name: "Add row", exact: true });
  const column = page.getByRole("button", { name: "Add column", exact: true });
  await row.waitFor({ state: "hidden" });
  await page.locator("td").first().hover();
  await column.waitFor({ state: "visible" });
  await row.waitFor({ state: "visible" });
  await column.click();
  assert.deepEqual(await page.locator("tr").first().locator("td").allTextContents(), ["A", "B", ""]);
  await cell(0);
  await page.mouse.move(700, 500);
  await row.click();
  assert.deepEqual(await page.locator("tr").nth(1).locator("td").allTextContents(), ["C", "D", ""]);
  assert.deepEqual(await page.locator("tr").last().locator("td").allTextContents(), ["", "", ""]);
  const saved = await page.evaluate(() => JSON.stringify(editor.getJSON()) + editor.getHTML());
  assert.doesNotMatch(saved, /button|toolbar|data-table-controls|table-edge|Add row|Add column/);
  await page.evaluate(() => { for (let i = 0; i < 6; i++) editor.commands.addColumnAfter(); });
  await page.locator(".tableWrapper").evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.waitForFunction(() => {
    const edge = document.querySelector('[aria-label="Add column"]');
    return edge && Math.abs(edge.getBoundingClientRect().left - document.querySelector('.tableWrapper').getBoundingClientRect().right) < 2;
  });
  await column.click();
  assert.equal(await page.locator("tr").first().locator("td").count(), 10);
});

test("caret toolbar adds on each side and deletes rows, columns, and the table", async () => {
  const toolbar = page.getByRole("toolbar", { name: "Table actions", exact: true });
  for (const [label, expected] of [
    ["Add row above", [["", ""], ["A", "B"], ["C", "D"]]],
    ["Add row below", [["A", "B"], ["", ""], ["C", "D"]]],
    ["Add column left", [["", "A", "B"], ["", "C", "D"]]],
    ["Add column right", [["A", "", "B"], ["C", "", "D"]]],
    ["Delete row", [["C", "D"]]],
    ["Delete column", [["B"], ["D"]]],
    ["Delete table", []],
  ]) {
    await fresh();
    await page.evaluate(() => editor.commands.setContent('<table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td><td><p>D</p></td></tr></table>'));
    await cell(0);
    await toolbar.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("toolbar", { name: "Text formatting" }).isVisible(), false);
    assert.equal(await toolbar.getByRole("button", { name: "Split cell", exact: true }).count(), 0);
    await toolbar.getByRole("button", { name: label, exact: true }).click();
    assert.deepEqual(await page.locator("tr").evaluateAll(rows => rows.map(row => Array.from(row.cells, c => c.textContent))), expected, label);
  }
});

test("Yjs round trip preserves cell content, merges, edits, deletion and undo", async () => {
  await insert();
  await cell(0);
  await page.keyboard.type("Question :: {{Answer}}");
  await cell(1);
  await page.keyboard.type("Other :: Value");
  const result = await page.evaluate(async () => {
    stopCapture();
    const cells = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "tableHeader") cells.push(pos); });
    editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[1] });
    editor.commands.mergeCells();
    const merged = editor.getJSON();
    editor.commands.undo();
    const mergeUndo = editor.state.doc.firstChild.child(0).childCount;
    editor.commands.redo();
    const mergeRedo = editor.getJSON();
    const cards = extractCards(editor.state.doc);
    const search = extractFromDoc(editor.state.doc);
    const persistedSearch = extractFromYDoc(documentY);
    const clone = cloneEditor();
    await new Promise(resolve => setTimeout(resolve, 40));
    const restored = clone.editor.getJSON();
    clone.editor.destroy(); clone.document.destroy();
    stopCapture();
    editor.commands.deleteTable();
    const deleted = editor.state.doc.textContent;
    editor.commands.undo();
    const undo = editor.getJSON();
    editor.commands.redo();
    const redo = editor.state.doc.textContent;
    return { merged, mergeUndo, mergeRedo, restored, cards, search, persistedSearch, deleted, undo, redo };
  });
  assert.equal(result.mergeUndo, 3);
  assert.deepEqual(result.mergeRedo, result.merged);
  assert.deepEqual(result.restored, result.merged);
  assert.deepEqual(result.undo, result.merged);
  assert.equal(result.deleted, "");
  assert.equal(result.redo, "");
  assert.deepEqual(result.search, result.persistedSearch);
  assert.equal(result.search.body, "Question :: {{Answer}}\nOther :: Value");
  assert.deepEqual(result.cards.map(card => card.kind), ["cloze", "basic"]);
  assert.ok(result.cards.every(card => card.blockId));
});

test("wide tables scroll inside the note in light and dark themes", async () => {
  await insert();
  for (const dark of [false, true]) {
    const dimensions = await page.evaluate(dark => {
      window.document.documentElement.classList.toggle("dark", dark);
      for (let i = 0; i < 8; i++) editor.commands.addColumnAfter();
      const wrapper = window.document.querySelector(".tableWrapper");
      return { width: wrapper.clientWidth, scroll: wrapper.scrollWidth, overflow: getComputedStyle(wrapper).overflowX };
    }, dark);
    assert.equal(dimensions.overflow, "auto");
    assert.ok(dimensions.width <= 420);
    assert.ok(dimensions.scroll > dimensions.width);
  }
});

test("schemas without tables preserve unsupported content and open read-only", async () => {
  await insert();
  const result = await page.evaluate(async () => {
    const clone = cloneEditor(true);
    const original = clone.initialBytes;
    await new Promise(resolve => setTimeout(resolve, 40));
    const beforeEdit = clone.document.getXmlFragment("default").toString();
    clone.editor.commands.insertContent("legacy edit");
    const afterEdit = clone.document.getXmlFragment("default").toString();
    const bytes = Array.from(Y.encodeStateAsUpdate(clone.document));
    const editable = clone.editor.isEditable;
    clone.editor.destroy(); clone.document.destroy();
    return { beforeEdit, afterEdit, original, bytes, editable };
  });
  assert.equal(result.beforeEdit.includes("<table>"), true);
  assert.equal(result.afterEdit, result.beforeEdit);
  assert.deepEqual(result.bytes, result.original);
  assert.equal(result.editable, false);
});

test("arrows leave a table and images round-trip within cells", async () => {
  await fresh();
  await page.evaluate(() => editor.commands.setContent("<p>before</p><table><tr><td><p>cell</p></td></tr></table><p>after</p>"));
  await cell(0);
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.textContent), "before");
  await cell(0, true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.textContent), "after");
  await cell(0);
  const result = await page.evaluate(async () => {
    execEditor(editor, "insertImage", { fileId: "table-image", alt: "cell image" });
    const image = editor.getJSON().content.find(node => node.type === "table").content[0].content[0].content.find(node => node.type === "image");
    const clone = cloneEditor();
    await new Promise(resolve => setTimeout(resolve, 40));
    const restored = clone.editor.getJSON().content.find(node => node.type === "table").content[0].content[0].content.find(node => node.type === "image");
    clone.editor.destroy(); clone.document.destroy();
    return { image, restored };
  });
  assert.equal(result.image.attrs.fileId, "table-image");
  assert.deepEqual(result.image, result.restored);
});

test("fold and focus treat a table as section content and outline ignores its cells", async () => {
  await fresh();
  const result = await page.evaluate(() => {
    editor.commands.setContent('<h1>First</h1><table><tr><td><p>cell text</p></td></tr></table><h1>Second</h1><p>visible</p>');
    editor.commands.setTextSelection(1);
    const headings = [];
    editor.state.doc.forEach((node, pos) => { if (node.type.name === "heading") headings.push(pos); });
    editor.commands.foldCurrentSection();
    const folded = getComputedStyle(window.document.querySelector(".tableWrapper")).display;
    editor.commands.unfoldCurrentSection();
    editor.commands.showSection(headings[1]);
    const focused = getComputedStyle(window.document.querySelector(".tableWrapper")).display;
    editor.commands.showDocument();
    const shown = getComputedStyle(window.document.querySelector(".tableWrapper")).display;
    return { folded, focused, shown, headings: headings.length };
  });
  assert.equal(result.folded, "none");
  assert.equal(result.focused, "none");
  assert.notEqual(result.shown, "none");
  assert.equal(result.headings, 2);
});

test("insertion and cell text edits have reversible collaborative history", async () => {
  await fresh();
  const result = await page.evaluate(() => {
    stopCapture();
    execEditor(editor, "insertTable");
    editor.commands.undo();
    const insertionUndone = editor.state.doc.textContent === "" && !editor.isActive("table");
    editor.commands.redo();
    stopCapture();
    editor.commands.insertContent("edited cell");
    editor.commands.undo();
    const editUndone = editor.state.doc.textContent;
    editor.commands.redo();
    const editRedone = editor.state.doc.textContent;
    return { insertionUndone, editUndone, editRedone };
  });
  assert.equal(result.insertionUndone, true);
  assert.equal(result.editUndone, "");
  assert.equal(result.editRedone, "edited cell");
  assert.equal((await counts()).table, 1);
});

test("MoveLines never reorders cells or rows at a cell boundary", async () => {
  await fresh();
  await page.evaluate(() => editor.commands.setContent('<p>before</p><table><tr><td><p>one</p></td><td><p>two</p></td></tr><tr><td><p>three</p></td><td><p>four</p></td></tr></table><p>after</p>'));
  await cell(1);
  const before = await page.evaluate(() => editor.getJSON());
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);
  await cell(2);
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);
});

test("block math conversion cannot lift selected cell content out of the table", async () => {
  await insert();
  await cell(0);
  await page.keyboard.type("formula");
  const before = await page.evaluate(() => editor.getJSON());
  const changed = await page.evaluate(() => {
    const to = editor.state.selection.from;
    editor.commands.setTextSelection({ from: to - 7, to });
    return editor.commands.toggleMathBlock();
  });
  assert.equal(changed, false);
  assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);
});

test("/image keeps its file input attached until a pick, then hands over the images", async () => {
  await fresh();
  await page.keyboard.type("/image");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const picker = await chooser;
  // A detached input can be collected while the dialog is open, losing the pick.
  assert.equal(await page.evaluate(() => document.querySelectorAll("input[data-image-picker]").length), 1);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await picker.setFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => window.pickedImages.length === 1);
  assert.deepEqual(await page.evaluate(() => window.pickedImages), ["pixel.png"]);
  assert.equal(await page.evaluate(() => document.querySelectorAll("input[data-image-picker]").length), 0);
});
