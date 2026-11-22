import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import * as Y from "yjs";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const { createServer } = browserHarness(import.meta.url);
const workspace = fileURLToPath(new URL("../../..", import.meta.url));
let server, browser, webkitBrowser, core, course, archive;
const pending = [];

function call(command, args = {}) {
  return new Promise((resolve, reject) => {
    pending.push(({ value, error }) => error ? reject(new Error(error.message ?? error)) : resolve(value));
    core.stdin.write(JSON.stringify({ command, args }) + "\n");
  });
}

async function createModule(name, titles, initialize = () => {}) {
  const moduleId = await call("create_module", { name });
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  fragment.insert(0, titles.flatMap((title, index) => {
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 1);
    const paragraph = new Y.XmlElement("paragraph");
    const body = new Y.XmlText();
    body.insert(0, title ? `Notes for ${title}.` : "An unfinished chapter.");
    paragraph.insert(0, [body]);
    if (title) {
      heading.setAttribute("data-toc-id", `${name}-${index}`);
      heading.setAttribute("id", `${name}-${index}`);
      const text = new Y.XmlText();
      text.insert(0, title);
      heading.insert(0, [text]);
    }
    return [heading, paragraph];
  }));
  initialize(fragment);
  await call("save_compaction", { moduleId, newState: Array.from(Y.encodeStateAsUpdate(doc)), updateId: 0 });
  doc.destroy();
  await call("set_module_numbering", { moduleId, enabled: true });
  return moduleId;
}

before(async () => {
  execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], {
    cwd: workspace, env: { ...process.env, CARGO_BUILD_JOBS: "4" }, stdio: "pipe",
  });
  core = spawn(`${workspace}/target/debug/examples/command-harness`, [], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: core.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  course = await createModule("Computing", ["Introduction", "", "Algorithms", "Data structures", "Complexity"]);
  archive = await createModule("Archive", ["Reference", "Appendix"]);
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await webkitBrowser?.close();
  await server?.close();
  if (core && core.exitCode === null) {
    const exited = once(core, "exit");
    core.stdin.end();
    await exited;
  }
});

async function openNote(moduleId, { sections = false, invoke = call, engine = "Chromium" } = {}) {
  const selectedBrowser = engine === "WebKit" ? webkitBrowser ??= await webkit.launch() : browser;
  const page = await selectedBrowser.newPage({ viewport: { width: 1150, height: 750 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => console.error(error));
  await page.context().route("https://api.github.com/repos/princhman/memnoter/releases/latest",
    route => route.fulfill({ status: 404, json: {} }));
  await page.exposeFunction("coreCall", invoke);
  const setup = sections => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    if (sections) localStorage.setItem("app-state", JSON.stringify({ sidebarSections: true }));
    window.installTestBridge({ tauri: { invoke: (command, args) => {
      if (command === "plugin:app|version") return "0.0.0";
      if (command === "plugin:window|is_fullscreen") return false;
      if (command.startsWith("plugin:") || command === "set_editor_history") return null;
      return window.coreCall(command, args);
    } } });
  };
  await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup})(${sections});`);
  await page.goto(`http://localhost:${server.httpServer.address().port}/${moduleId}`);
  await page.locator(".tiptap[contenteditable=true]").waitFor();
  return page;
}

test("opening an editable legacy note with sidebar sections off leaves the stored document untouched", async () => {
  const moduleId = await createModule("Legacy", ["Introduction", "", "Algorithms"]);
  const before = await call("get_content", { moduleId });
  const page = await openNote(moduleId);
  try {
    const emptyHeading = page.locator(".tiptap > h1").nth(1);
    await emptyHeading.locator(".heading-number").waitFor();
    assert.equal(await emptyHeading.getAttribute("data-toc-id"), null);
    assert.equal(await page.getByRole("list", { name: "Sections of Legacy" }).count(), 0);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.locator(".tiptap").waitFor({ state: "detached" });
    assert.deepEqual(await call("get_content", { moduleId }), before);
  } finally {
    await page.close();
  }
});

test("the New section shortcut still focuses the new sibling with sidebar sections off", async () => {
  const moduleId = await createModule("Keyboard", ["First", "Last"]);
  const page = await openNote(moduleId);
  try {
    const contents = page.getByRole("navigation", { name: "Table of contents" });
    await contents.getByRole("button", { name: "1 First", exact: true }).hover();
    await contents.getByRole("button", { name: "Focus on First", exact: true }).press("Enter");
    const headings = page.locator(".tiptap > h1");
    await headings.first().click();
    await page.keyboard.press("Meta+Alt+s");
    await page.keyboard.type("New sibling");
    assert.deepEqual(await headings.filter({ visible: true }).allTextContents(), ["2\u00a0New sibling"]);
  } finally {
    await page.close();
  }
});

for (const method of ["New section shortcut", "Markdown heading input rule"]) {
  test(`undo removes the empty heading from the ${method} before the earlier edit`, async () => {
    const moduleId = await createModule(method, ["First", "Last"], fragment => {
      fragment.insert(3, [new Y.XmlElement("paragraph")]);
    });
    const page = await openNote(moduleId, { sections: true });
    try {
      const headings = page.locator(".tiptap > h1");
      const paragraphs = page.locator(".tiptap > p");
      await paragraphs.first().click();
      await page.keyboard.press("End");
      await page.keyboard.type("!");
      await paragraphs.first().filter({ hasText: "Notes for First.!" }).waitFor();
      // Separate the edits by more than the Yjs undo capture timeout.
      await page.waitForTimeout(550);
      if (method === "New section shortcut") {
        await page.keyboard.press("Meta+Alt+s");
      } else {
        await paragraphs.nth(1).click();
        await page.keyboard.insertText("# ");
      }
      await headings.nth(2).waitFor();
      await page.keyboard.press("Meta+z");
      assert.deepEqual(await headings.allTextContents(), ["1\u00a0First", "2\u00a0Last"]);
      assert.equal(await paragraphs.first().textContent(), "Notes for First.!");
      await page.keyboard.press("Meta+z");
      assert.equal(await paragraphs.first().textContent(), "Notes for First.");
    } finally {
      await page.close();
    }
  });
}

test("chapter numbers match in the sidebar and editor when editing a legacy heading and adding a section", async () => {
  const moduleId = await createModule("Numbered chapters", ["Introduction", "", "Algorithms"]);
  const page = await openNote(moduleId, { sections: true });
  const sidebar = page.getByRole("list", { name: "Sections of Numbered chapters" });
  const headings = page.locator(".tiptap > h1");
  const module = page.getByRole("link", { name: "Numbered chapters", exact: true });
  const chapter = name => sidebar.getByRole("button", { name, exact: true });

  async function checkNumbers(expected) {
    for (const label of expected) await chapter(label).waitFor();
    const rows = await sidebar.getByRole("button").evaluateAll(rows => rows.map(row => row.title));
    const editorLabels = (await headings.filter({ visible: true }).allTextContents()).map(text => {
      const [number, title] = text.split("\u00a0");
      return `${number} ${title || "Untitled section"}`;
    });
    assert.deepEqual(rows, expected, "sidebar chapter labels");
    assert.deepEqual(editorLabels, expected, "editor chapter labels");
  }

  try {
    await checkNumbers(["1 Introduction", "2 Untitled section", "3 Algorithms"]);
    await headings.nth(1).click();
    await page.keyboard.type("Foundations");
    await checkNumbers(["1 Introduction", "2 Foundations", "3 Algorithms"]);

    await chapter("3 Algorithms").click();
    await module.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
    await chapter("4 Untitled section").waitFor();
    await page.keyboard.type("Networks");
    await checkNumbers(["1 Introduction", "2 Foundations", "3 Algorithms", "4 Networks"]);
  } finally {
    await page.close();
  }
});

test("dragging a sidebar section row leaves the note and module order in place", async () => {
  const page = await openNote(course, { sections: true });
  const sidebar = page.getByRole("list", { name: "Sections of Computing" });
  const headings = page.locator(".tiptap > h1").filter({ visible: true });
  const section = sidebar.getByRole("button", { name: "3 Algorithms", exact: true });
  const target = sidebar.getByRole("button", { name: "1 Introduction", exact: true });
  const module = page.getByRole("link", { name: "Computing", exact: true });
  const moduleOrder = () => page.locator("[data-sidebar-item] a").allTextContents();

  try {
    await section.click();
    assert.deepEqual(await headings.allTextContents(), ["3\u00a0Algorithms"]);
    await module.click();
    await headings.first().waitFor();
    assert.equal(await headings.count(), 5);
    const modulesBefore = await moduleOrder();
    const sectionsBefore = await sidebar.getByRole("button").allTextContents();
    const noteBefore = await page.locator(".tiptap").innerText();

    const sourceBox = await section.boundingBox();
    const targetBox = await target.boundingBox();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 4, { steps: 20 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const previewCount = await page.locator("[data-sidebar-drag-preview]").count();
    await page.mouse.up();

    assert.equal(previewCount, 0, "neither a section nor its module picks up");
    assert.deepEqual(await moduleOrder(), modulesBefore);
    assert.deepEqual(await sidebar.getByRole("button").allTextContents(), sectionsBefore);
    assert.equal(await page.locator(".tiptap").innerText(), noteBefore);
    assert.equal(new URL(page.url()).pathname, `/${course}`);
  } finally {
    await page.close();
  }
});

test("opening a note after expanding its sidebar sections still cleans up orphan attachments", async () => {
  const moduleId = await createModule("Attachments", ["First", "Last"]);
  const file = await call("save_file", { moduleId, bytes: [1, 2, 3], mimeType: "image/png" });
  const page = await openNote(course, { sections: true });
  try {
    await page.getByRole("button", { name: "Expand sections of Attachments" }).click();
    const rows = page.getByRole("list", { name: "Sections of Attachments" });
    await rows.getByRole("button", { name: "2 Last", exact: true }).waitFor();
    assert.deepEqual((await call("get_content", { moduleId })).files.map(item => item.id), [file.id]);
    await page.getByRole("link", { name: "Attachments", exact: true }).click();
    const editor = page.locator(".tiptap[contenteditable=true]");
    await editor.getByText("Notes for Last.", { exact: true }).waitFor();
    assert.deepEqual((await call("get_content", { moduleId })).files, []);
  } finally {
    await page.close();
  }
});

for (const duplicateId of [false, true]) {
  const label = duplicateId
    ? "a closed note opens its untitled section when it shares the next heading's id"
    : "a closed note's legacy untitled section opens in section focus";
  test(label, async () => {
    const name = duplicateId ? "Duplicate chapter ids" : "Untitled chapters";
    const moduleId = await createModule(name, ["First", "", "Last"], fragment => {
      if (!duplicateId) return;
      const id = fragment.get(4).getAttribute("data-toc-id");
      fragment.get(2).setAttribute("data-toc-id", id);
      fragment.get(2).setAttribute("id", id);
    });
    const page = await openNote(course, { sections: true });
    try {
      await page.getByRole("button", { name: `Expand sections of ${name}` }).click();
      const rows = page.getByRole("list", { name: `Sections of ${name}` });
      await rows.getByRole("button", { name: "2 Untitled section", exact: true }).click();
      assert.equal(new URL(page.url()).pathname, `/${moduleId}`);
      await page.locator(".tiptap > .section-focus-start").waitFor({ timeout: 3000 });
      const visibleHeadings = page.locator(".tiptap > h1").filter({ visible: true });
      assert.deepEqual(await visibleHeadings.allTextContents(), ["2\u00a0"]);
      await page.getByRole("link", { name, exact: true }).click();
      await page.locator(".tiptap.section-focused").waitFor({ state: "detached" });
      assert.equal(await visibleHeadings.count(), 3);
    } finally {
      await page.close();
    }
  });
}

test("a closed note focuses the chapter whose id was shared by a nested heading", async () => {
  const name = "Nested duplicate id";
  const moduleId = await createModule(name, ["First", "Last"], fragment => {
    const quote = new Y.XmlElement("blockquote");
    const heading = new Y.XmlElement("heading");
    heading.setAttribute("level", 1);
    heading.setAttribute("data-toc-id", fragment.get(2).getAttribute("data-toc-id"));
    const text = new Y.XmlText();
    text.insert(0, "Quoted heading");
    heading.insert(0, [text]);
    quote.insert(0, [heading]);
    fragment.insert(2, [quote]);
  });
  // Orphan cleanup keeps the destination loading while the editor repairs IDs.
  await call("save_file", { moduleId, bytes: [1, 2, 3], mimeType: "image/png" });
  const { promise: releaseCleanup, resolve: finishCleanup } = Promise.withResolvers();
  const page = await openNote(course, { sections: true, async invoke(command, args) {
    if (command === "cleanup_files" && args.moduleId === moduleId) await releaseCleanup;
    return call(command, args);
  } });
  try {
    await page.getByRole("button", { name: `Expand sections of ${name}` }).click();
    await page.getByRole("list", { name: `Sections of ${name}` })
      .getByRole("button", { name: "2 Last", exact: true }).click();
    await page.waitForURL(`**/${moduleId}`);
    await page.locator(`.tiptap > h1:not([data-toc-id="${name}-1"])`)
      .filter({ hasText: "Last" }).waitFor();
    finishCleanup();
    await page.locator(".tiptap > h1.section-focus-start").waitFor({ timeout: 3000 });
    assert.deepEqual(await page.locator(".tiptap > h1:visible").allTextContents(), ["2\u00a0Last"]);
  } finally {
    finishCleanup();
    await page.close();
  }
});

test("expanding a newer-format note reports an error only in its sidebar row", async () => {
  const moduleId = await createModule("Future sections", ["First"], fragment => {
    const future = new Y.XmlElement("futureBlock");
    future.insert(0, [new Y.XmlFragment()]);
    fragment.insert(2, [future]);
  });
  const page = await openNote(course, { sections: true });
  try {
    await page.getByRole("button", { name: "Expand sections of Future sections" }).click();
    const rows = page.getByRole("list", { name: "Sections of Future sections" });
    await rows.getByRole("alert").filter({ hasText: "Could not load sections." }).waitFor();
    await page.locator(".tiptap[contenteditable=true]").getByText("Notes for Complexity.", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/${course}`);

    await page.getByRole("link", { name: "Future sections", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "This note was edited with a newer version" }).waitFor();
    await page.locator(".tiptap[contenteditable=false]").waitFor({ state: "attached" });
    assert.equal(new URL(page.url()).pathname, `/${moduleId}`);
  } finally {
    await page.close();
  }
});

async function focusMiddleSection(page) {
  const contents = page.getByRole("navigation", { name: "Table of contents" });
  await contents.getByRole("button", { name: "2 Middle", exact: true }).hover();
  await contents.getByRole("button", { name: "Focus on Middle", exact: true }).press("Enter");
  await page.locator(".tiptap > p").filter({ hasText: "Notes for Middle." }).click();
}

test("Backspace at the focused heading converts it without joining the hidden chapter", async () => {
  const moduleId = await createModule("Heading Backspace", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    await editor.locator(":scope > h1.section-focus-start").evaluate(node => {
      const { editor } = node.parentElement;
      editor.commands.setTextSelection(editor.view.posAtDOM(node, 0));
    });
    await page.keyboard.press("Backspace");
    assert.deepEqual(await editor.locator(":scope > h1").allTextContents(), ["1\u00a0Before", "2\u00a0After"]);
    assert.deepEqual(await editor.locator(":scope > p").allTextContents(),
      ["Notes for Before.", "Middle", "Notes for Middle.", "Notes for After."]);
  } finally {
    await page.close();
  }
});

test("forward Delete at the focused end keeps the next chapter intact", async () => {
  const moduleId = await createModule("Forward Delete", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    const snapshot = () => editor.evaluate(({ editor }) => editor.getJSON());
    const before = await snapshot();
    await page.keyboard.press("End");
    await page.keyboard.press("Delete");
    assert.deepEqual(await snapshot(), before);
    await editor.locator(":scope > h1.section-focus-start").waitFor();
  } finally {
    await page.close();
  }
});

test("a programmatic edit reveals hidden changes regardless of caret placement", async () => {
  const moduleId = await createModule("Programmatic edits", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId, { sections: true });
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    await editor.evaluate(({ editor }) => {
      const { doc } = editor.state;
      editor.commands.setTextSelection(2);
      const position = doc.child(0).nodeSize + doc.child(1).nodeSize + doc.child(2).nodeSize + 1;
      editor.view.dispatch(editor.state.tr.insertText("Visible edit. ", position));
    });
    await editor.getByText("Visible edit. Notes for Middle.", { exact: true }).waitFor();
    assert.deepEqual(await editor.locator(":scope > h1").filter({ visible: true }).allTextContents(), ["2\u00a0Middle"]);

    await editor.evaluate(({ editor }) => {
      const { doc } = editor.state;
      const position = doc.child(0).nodeSize + 1;
      editor.commands.setTextSelection(doc.child(0).nodeSize + doc.child(1).nodeSize + 1);
      editor.view.dispatch(editor.state.tr.insertText("Hidden edit. ", position).setMeta("addToHistory", false));
    });
    await editor.getByText("Hidden edit. Notes for Before.", { exact: true }).waitFor();
    assert.equal(await editor.locator(":scope > h1").filter({ visible: true }).count(), 3);
  } finally {
    await page.close();
  }
});

async function syncPeerEdit(page, moduleId, edit) {
  const peer = new Y.Doc();
  try {
    const { state, updates } = await call("get_content", { moduleId });
    Y.applyUpdate(peer, Uint8Array.from(state));
    for (const { bytes } of updates) Y.applyUpdate(peer, Uint8Array.from(bytes));
    const base = Y.encodeStateVector(peer);
    edit(peer.getXmlFragment("default"));
    const bytes = Array.from(Y.encodeStateAsUpdate(peer, base));
    await page.evaluate(async ({ moduleId, bytes }) => {
      const { onRemote } = await import("/src/lib/sync/apply-remote.ts");
      onRemote({ updates: [{ moduleId, update: { id: 9000, bytes } }], modulesChanged: false,
        deleted: [], reviewsChanged: false, filesChanged: false });
    }, { moduleId, bytes });
  } finally {
    peer.destroy();
  }
}

test("a synced outline id change keeps focus on the surviving heading", async () => {
  const moduleId = await createModule("Remote outline", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId, { sections: true });
  try {
    await focusMiddleSection(page);
    await syncPeerEdit(page, moduleId, fragment => {
      fragment.get(1).get(0).insert(0, "Peer edit. ");
      const heading = fragment.get(2);
      heading.setAttribute("data-toc-id", "peer-middle-id");
      heading.setAttribute("id", "peer-middle-id");
    });
    const editor = page.locator(".tiptap");
    await editor.locator('[data-toc-id="peer-middle-id"]').waitFor({ state: "attached" });
    assert.deepEqual(await editor.locator(":scope > h1").filter({ visible: true }).allTextContents(), ["2\u00a0Middle"]);
    assert.equal(await editor.getByText("Peer edit. Notes for Before.", { exact: true }).count(), 1);
  } finally {
    await page.close();
  }
});

test("typing stays in the focused section after a peer deletes the caret paragraph", async () => {
  const moduleId = await createModule("Remote caret", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId, { sections: true });
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    await syncPeerEdit(page, moduleId, fragment => fragment.delete(3, 1));
    await editor.getByText("Notes for Middle.", { exact: true }).waitFor({ state: "detached" });
    await page.keyboard.type("!");
    assert.deepEqual(await editor.locator(":scope > h1").allTextContents(), ["1\u00a0Before", "2\u00a0Middle!", "3\u00a0After"]);
    assert.equal(await editor.locator(":scope > h1.section-focus-start").textContent(), "2\u00a0Middle!");
  } finally {
    await page.close();
  }
});

test("Select All selects only the focused section and restores whole-note selection after clearing focus", async () => {
  const moduleId = await createModule("Selection", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  const selectedText = () => page.locator(".tiptap").evaluate(({ editor }) => {
    const { doc, selection } = editor.state;
    return doc.textBetween(selection.from, selection.to, "\n");
  });
  try {
    await focusMiddleSection(page);
    await page.keyboard.press("Meta+a");
    assert.equal(await selectedText(), "Middle\nNotes for Middle.");
    await page.locator(".tiptap").evaluate(({ editor }) => editor.commands.showDocument());
    await page.keyboard.press("Meta+a");
    assert.equal(await selectedText(), "Before\nNotes for Before.\nMiddle\nNotes for Middle.\nAfter\nNotes for After.");
  } finally {
    await page.close();
  }
});

test("Shift-Arrow and node selections stay inside the focused section", async () => {
  const moduleId = await createModule("Selection boundaries", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    assert.equal(await editor.evaluate(({ editor }) => {
      const { doc, selection } = editor.state;
      const start = doc.child(0).nodeSize + doc.child(1).nodeSize;
      const end = start + doc.child(2).nodeSize + doc.child(3).nodeSize;
      return selection.from >= start && selection.to <= end;
    }), true);
    await editor.evaluate(({ editor }) => {
      const { doc } = editor.state;
      editor.commands.setNodeSelection(doc.content.size - doc.lastChild.nodeSize);
    });
    await page.keyboard.type("!");
    assert.equal(await editor.locator(":scope > p").nth(1).textContent(), "Notes for Middle.!");
    assert.equal(await editor.locator(":scope > p").last().textContent(), "Notes for After.");
  } finally {
    await page.close();
  }
});

function selectAcrossHiddenSections(node) {
  const { editor } = node;
  editor.commands.setTextSelection({
    from: editor.state.doc.firstChild.nodeSize - 2,
    to: editor.state.doc.content.size - 2,
  });
}

async function focusFromHeadingToolbar(page, headingIndex) {
  await page.locator(".tiptap > h1").nth(headingIndex).hover();
  await page.getByRole("toolbar", { name: "Heading controls" })
    .getByRole("button", { name: "Focus on this section", exact: true }).click();
  await page.locator(".tiptap > h1").nth(headingIndex).and(page.locator(".section-focus-start")).waitFor();
}

async function savedBlocks(moduleId) {
  const doc = new Y.Doc();
  try {
    const { state, updates } = await call("get_content", { moduleId });
    Y.applyUpdate(doc, Uint8Array.from(state));
    for (const { bytes } of updates) Y.applyUpdate(doc, Uint8Array.from(bytes));
    return doc.getXmlFragment("default").toArray().map(block => block.toJSON());
  } finally {
    doc.destroy();
  }
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine}: Tab after focusing a cross-chapter selection keeps both hidden chapters saved`, async () => {
    const moduleId = await createModule("Tab selection", ["Before", "Middle", "After"]);
    const page = await openNote(moduleId, { engine });
    try {
      const editor = page.locator(".tiptap");
      await editor.locator(":scope > h1").first().click();
      await editor.evaluate(selectAcrossHiddenSections);
      const before = await savedBlocks(moduleId);
      await focusFromHeadingToolbar(page, 0);
      await page.keyboard.press("Tab");
      await page.evaluate(async () => {
        const { flushSaves } = await import("/src/lib/saves.ts");
        await flushSaves();
      });
      const saved = await savedBlocks(moduleId);
      assert.deepEqual(saved.slice(-4), before.slice(-4));
      assert.notDeepEqual(saved, before, "Tab edits the visible chapter");
    } finally {
      await page.close();
    }
  });

  test(`${engine}: typing after toolbar focus starts in the newly visible heading`, async () => {
    const moduleId = await createModule("Toolbar caret", ["Before", "Middle", "After"]);
    const page = await openNote(moduleId, { engine });
    try {
      await page.locator(".tiptap > p").first().click();
      await focusFromHeadingToolbar(page, 1);
      await page.keyboard.type("!");
      assert.deepEqual(await page.locator(".tiptap > h1").allTextContents(), ["1\u00a0Before", "2\u00a0!Middle", "3\u00a0After"]);
      assert.equal(await page.locator(".tiptap > p").first().textContent(), "Notes for Before.");
    } finally {
      await page.close();
    }
  });
}

test("registered editor shortcuts keep hidden chapters unchanged after toolbar focus", async () => {
  const moduleId = await createModule("Shortcut sweep", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  const editor = page.locator(".tiptap");
  try {
    const keys = await editor.evaluate(async ({ editor }) => {
      const { getExtensionField, getSchemaTypeByName } = await import("/node_modules/@tiptap/core/dist/index.js");
      return [...new Set(editor.extensionManager.extensions.flatMap(extension => {
        const shortcuts = getExtensionField(extension, "addKeyboardShortcuts", {
          name: extension.name,
          options: extension.options,
          storage: editor.extensionStorage[extension.name],
          editor,
          type: getSchemaTypeByName(extension.name, editor.schema),
        });
        return Object.keys(shortcuts?.() ?? {});
      }))];
    });
    assert.ok(keys.includes("Tab"));
    const original = await editor.evaluate(({ editor }) => editor.getJSON());
    const damaged = [];
    for (const key of keys) {
      await editor.evaluate(async ({ editor }, original) => {
        const { yUndoPluginKey } = await import("/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js");
        editor.chain().showDocument().setContent(original).run();
        const history = yUndoPluginKey.getState(editor.state).undoManager;
        history.clear();
        history.stopCapturing();
        editor.view.focus();
      }, original);
      await editor.evaluate(selectAcrossHiddenSections);
      await focusFromHeadingToolbar(page, 0);
      await page.keyboard.press(key.split("-").map(part => ({ Mod: "Meta", Ctrl: "Control" })[part] ?? part).join("+"));
      const hidden = await editor.evaluate(({ editor }) => editor.getJSON().content.slice(-4));
      if (JSON.stringify(hidden) !== JSON.stringify(original.content.slice(-4))) damaged.push(key);
      await page.keyboard.press("Escape");
    }
    assert.deepEqual(damaged, [], "shortcuts that changed hidden chapters");
  } finally {
    await page.close();
  }
});

test("a list shortcut cannot join across the focused edge, while a programmatic join reveals it", async () => {
  const moduleId = await createModule("List join", ["Before", "Middle", "After"], fragment => {
    const list = new Y.XmlElement("bulletList");
    const item = new Y.XmlElement("listItem");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Hidden list");
    paragraph.insert(0, [text]);
    item.insert(0, [paragraph]);
    list.insert(0, [item]);
    fragment.insert(2, [list]);
  });
  const page = await openNote(moduleId);
  try {
    const editor = page.locator(".tiptap");
    const hiddenList = editor.locator(":scope > ul").first();
    await editor.locator(":scope > h1").first().click();
    await editor.evaluate(selectAcrossHiddenSections);
    await focusFromHeadingToolbar(page, 1);
    await page.keyboard.press("Meta+Shift+8");
    assert.deepEqual(await hiddenList.locator("li").allTextContents(), ["Hidden list"]);
    await editor.locator(":scope > h1.section-focus-start").waitFor();

    await editor.evaluate(({ editor }) => editor.commands.toggleBulletList());
    await hiddenList.waitFor();
    assert.deepEqual(await hiddenList.locator("li").allTextContents(), ["Hidden list", "Middle", "Notes for Middle."]);
    assert.equal(await editor.locator(":scope > h1.section-focus-start").count(), 0);
  } finally {
    await page.close();
  }
});

test("typing, cut and Markdown paste act on the clamped selection and keep hidden text", async () => {
  const moduleId = await createModule("Input boundary", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    const editor = page.locator(".tiptap");
    const snapshot = () => editor.evaluate(({ editor }) => editor.getJSON().content);
    const before = await snapshot();
    for (const type of ["typing", "cut", "paste"]) {
      await focusMiddleSection(page);
      await editor.evaluate(selectAcrossHiddenSections);
      if (type === "typing") {
        await page.keyboard.insertText("Replacement");
      } else {
        await editor.evaluate((node, type) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", "# Markdown heading\n\n- list item");
          node.dispatchEvent(new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true }));
        }, type);
      }
      const after = await snapshot();
      assert.deepEqual(after.slice(0, 2), before.slice(0, 2), type);
      assert.deepEqual(after.slice(-2), before.slice(-2), type);
      assert.notDeepEqual(after, before, type);
      await page.keyboard.press("Meta+z");
      assert.deepEqual(await snapshot(), before, `undo ${type}`);
      await editor.evaluate(({ editor }) => editor.commands.showDocument());
    }
  } finally {
    await page.close();
  }
});

test("section focus rejects an escaped native composition and its hidden edits before Yjs", async () => {
  const moduleId = await createModule("Composition", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    const snapshot = () => editor.evaluate(({ editor }) => {
      const collaboration = editor.extensionManager.extensions.find(ext => ext.name === "collaboration");
      return {
        content: editor.getJSON(),
        shared: collaboration.options.document.getXmlFragment("default").toJSON(),
      };
    });
    const before = await snapshot();
    const cancelled = await editor.evaluate(node => {
      const { editor } = node;
      const start = editor.view.domAtPos(1);
      const end = editor.view.domAtPos(editor.state.doc.content.size - 1);
      // Native composition can start before PM observes a DOM selection change.
      getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      const cancelled = !node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, cancelable: true }));
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.delete(1, editor.state.doc.content.size - 1).setMeta("composition", 1));
      return cancelled;
    });
    assert.equal(cancelled, true);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await page.close();
  }
});

test("undo and redo reveal edits in a hidden chapter", async () => {
  const moduleId = await createModule("History", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId, { sections: true });
  try {
    const after = page.locator(".tiptap > p").filter({ hasText: "Notes for After." });
    await after.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited");
    const focusBefore = async () => {
      await page.getByRole("list", { name: "Sections of History" })
        .getByRole("button", { name: "1 Before", exact: true }).click();
      await page.locator(".tiptap > p").filter({ hasText: "Notes for Before." }).click();
      await after.waitFor({ state: "hidden" });
    };
    await focusBefore();
    await page.keyboard.press("Meta+z");
    await after.waitFor({ timeout: 3000 });
    assert.equal(await after.textContent(), "Notes for After.");
    await focusBefore();
    await page.keyboard.press("Meta+Shift+z");
    await after.waitFor({ timeout: 3000 });
    assert.equal(await after.textContent(), "Notes for After. Edited");
  } finally {
    await page.close();
  }
});

for (const target of ["Add section", "section row", "module title"]) {
  test(`a blocked ${target} request cannot replay on Back and a fresh request works`, async () => {
    const sourceName = `Save source (${target})`;
    const destinationName = `Destination (${target})`;
    const a = await createModule(sourceName, ["Before"]);
    const b = await createModule(destinationName, ["Existing", "Next"]);
    let failing = false;
    const page = await openNote(b, { sections: true, invoke(command, args) {
      if (failing && command === "sync_cards" && args.moduleId === a) throw new Error("test card save failure");
      return call(command, args);
    } });
    const editor = page.locator(".tiptap[contenteditable=true]");
    const source = page.getByRole("link", { name: sourceName, exact: true });
    const destination = page.getByRole("link", { name: destinationName, exact: true });
    const row = name => page.getByRole("list", { name: `Sections of ${destinationName}` })
      .getByRole("button", { name, exact: true });
    const request = async () => {
      if (target === "section row") return row("2 Next").click();
      if (target === "module title") return destination.click();
      await destination.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
    };
    try {
      if (target === "module title") {
        await row("1 Existing").click();
        await editor.locator(":scope > h1.section-focus-start").waitFor();
      }
      await source.click();
      await editor.getByText("Notes for Before.", { exact: true }).waitFor();
      failing = true;
      await editor.locator(":scope > p").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Prompt :: answer");
      const blocked = page.waitForEvent("dialog");
      const attempted = request();
      const dialog = await blocked;
      assert.match(dialog.message(), /Could not save flashcards/);
      await dialog.accept();
      await attempted;
      assert.equal(new URL(page.url()).pathname, `/${a}`);

      failing = false;
      await page.evaluate(() => history.back());
      await editor.getByText("Notes for Existing.", { exact: true }).waitFor();
      const visible = () => editor.locator(":scope > h1").filter({ visible: true }).allTextContents();
      assert.deepEqual(await visible(), target === "module title" ? ["1\u00a0Existing"] : ["1\u00a0Existing", "2\u00a0Next"]);

      await source.click();
      await page.waitForURL(`**/${a}`);
      await editor.locator(":scope > p").filter({ hasText: "Prompt" }).waitFor();
      await request();
      await page.waitForURL(`**/${b}`);
      if (target === "Add section") {
        await editor.locator(":scope > h1").nth(2).waitFor();
        await page.keyboard.type("Added");
        assert.deepEqual(await visible(), ["1\u00a0Existing", "2\u00a0Next", "3\u00a0Added"]);
      } else {
        await editor.getByText("Notes for Next.", { exact: true }).waitFor();
        assert.deepEqual(await visible(), target === "section row" ? ["2\u00a0Next"] : ["1\u00a0Existing", "2\u00a0Next"]);
      }
    } finally {
      await page.close();
    }
  });
}

test("only the latest sidebar section click commits while a card save is pending", async () => {
  const source = await createModule("Pending card save", ["Source"]);
  const { promise: saving, resolve: started } = Promise.withResolvers();
  const { promise: held, resolve: release } = Promise.withResolvers();
  const page = await openNote(source, { sections: true, async invoke(command, args) {
    if (command === "sync_cards" && args.moduleId === source && args.cards.length > 0) {
      started();
      await held;
    }
    return call(command, args);
  } });
  try {
    for (const name of ["Computing", "Archive"]) {
      await page.getByRole("button", { name: `Expand sections of ${name}` }).click();
    }
    const editor = page.locator(".tiptap[contenteditable=true]");
    await editor.locator(":scope > p").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Prompt :: answer");
    await saving;

    const historyLength = await page.evaluate(() => history.length);
    await page.getByRole("list", { name: "Sections of Computing" })
      .getByRole("button", { name: "3 Algorithms", exact: true }).click();
    await page.getByRole("list", { name: "Sections of Archive" })
      .getByRole("button", { name: "2 Appendix", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, `/${source}`);
    release();

    await page.waitForURL(`**/${archive}`);
    await editor.getByText("Notes for Appendix.", { exact: true }).waitFor();
    assert.deepEqual(await editor.locator(":scope > h1").filter({ visible: true }).allTextContents(), ["2\u00a0Appendix"]);
    assert.equal(await page.evaluate(() => history.length), historyLength + 1);
    await page.evaluate(() => history.back());
    await page.waitForURL(`**/${source}`);
  } finally {
    release();
    await page.close();
  }
});

test("card ID conflict repair indexes a hidden card without leaving section focus", async () => {
  const cardId = crypto.randomUUID();
  const initialize = fragment => {
    const paragraph = fragment.get(1);
    paragraph.setAttribute("cardId", cardId);
    const text = paragraph.get(0);
    text.delete(0, text.length);
    text.insert(0, "Question :: answer");
  };
  const owner = await createModule("Original card", ["Before"], initialize);
  await call("sync_cards", { moduleId: owner, cards: [{ id: cardId, kind: "basic", front: "Question", back: "answer" }] });
  const moduleId = await createModule("Copied card", ["Before", "Middle", "After"], initialize);

  const { promise: focused, resolve: release } = Promise.withResolvers();
  const page = await openNote(moduleId, { async invoke(command, args) {
    if (command === "sync_cards" && args.moduleId === moduleId) await focused;
    return call(command, args);
  } });
  try {
    await focusMiddleSection(page);
    release();
    await page.evaluate(moduleId => {
      const check = async () => {
        window.hiddenCardIndexed = (await window.coreCall("card_schedules", { moduleId })).length === 1;
        if (!window.hiddenCardIndexed) setTimeout(check, 50);
      };
      void check();
    }, moduleId);
    await page.waitForFunction(() => window.hiddenCardIndexed, null, { timeout: 4000 });
    const [copied] = await call("card_schedules", { moduleId });
    const [existing] = await call("card_schedules", { moduleId: owner });
    assert.notEqual(copied.id, existing.id);
    assert.deepEqual(await page.locator(".tiptap > h1").filter({ visible: true }).allTextContents(), ["2\u00a0Middle"]);
  } finally {
    release();
    await page.close();
  }
});

test("Insert heading above adopts the hidden next chapter with sidebar sections off", async () => {
  const moduleId = await createModule("Insert parent", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    await page.locator(".tiptap > p").filter({ hasText: "Notes for Middle." }).evaluate((node) => {
      const { editor } = node.parentElement;
      editor.commands.setTextSelection(editor.view.posAtDOM(node, node.childNodes.length));
      editor.view.focus();
    });
    await page.keyboard.press("Enter");
    await page.keyboard.type("/insert title");
    await page.getByRole("option", { name: /Insert heading above/ }).click();
    await page.keyboard.type("Parent");
    const editor = page.locator(".tiptap");
    await editor.locator(":scope > h2").filter({ hasText: "After" }).waitFor();
    assert.deepEqual(await editor.locator(":scope > h1").filter({ visible: true }).allTextContents(),
      ["1\u00a0Before", "2\u00a0Middle", "3\u00a0Parent"]);
  } finally {
    await page.close();
  }
});

test("focused Select All keeps a trailing block image selected across sync", async () => {
  const moduleId = await createModule("Image selection", ["Before", "Middle", "After"], fragment => {
    fragment.insert(4, [new Y.XmlElement("image")]);
  });
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    await page.keyboard.press("Meta+a");
    const editor = page.locator(".tiptap");
    const selected = () => editor.evaluate(({ editor }) => ({
      type: editor.state.selection.toJSON().type,
      blocks: editor.state.selection.content().content.toJSON().map(node => node.type),
    }));
    const expected = { type: "section-selection", blocks: ["heading", "paragraph", "image"] };
    assert.deepEqual(await selected(), expected);
    const highlights = await page.locator(".tiptap .text-range-selected").allTextContents();
    assert.deepEqual(highlights, ["Middle", "Notes for Middle."]);
    await syncPeerEdit(page, moduleId, fragment => fragment.get(3).get(0).insert(0, "Peer edit. "));
    await editor.getByText("Peer edit. Notes for Middle.", { exact: true }).waitFor();
    assert.deepEqual(await selected(), expected);
    await page.keyboard.press("Backspace");
    const remaining = await page.locator(".tiptap > h1").allTextContents();
    assert.deepEqual(remaining, ["1\u00a0Before", "2\u00a0After"]);
  } finally {
    await page.close();
  }
});
