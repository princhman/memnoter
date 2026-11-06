import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

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
  await page.evaluate(() => {
    const cells = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "tableHeader") cells.push(pos); });
    editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[1] });
  });
  await page.getByRole("button", { name: "Merge cells", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Bold", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Merge cells", exact: true }).click();
  assert.equal((await counts()).tableHeader, 2);
  assert.equal(await page.evaluate(() => execEditor(editor, "splitCell")), true);
  assert.equal((await counts()).tableHeader, 3);
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

test("legacy schemas delete unsupported tables from the synced Yjs XML", async () => {
  await insert();
  const result = await page.evaluate(async () => {
    const clone = cloneEditor(true);
    await new Promise(resolve => setTimeout(resolve, 40));
    const beforeEdit = clone.document.getXmlFragment("default").toString();
    clone.editor.commands.insertContent("legacy edit");
    const afterEdit = clone.document.getXmlFragment("default").toString();
    clone.editor.destroy(); clone.document.destroy();
    return { beforeEdit, afterEdit };
  });
  assert.equal(result.beforeEdit.includes("<table>"), false);
  assert.equal(result.afterEdit.includes("<table>"), false);
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
