import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Add section focuses the numbered title and one undo removes the new section", async () => {
  const moduleId = await createModule("Numbered chapters", ["Introduction", "", "Algorithms"]);
  const page = await openNote(moduleId, { sections: true });
  const sidebar = page.getByRole("list", { name: "Sections of Numbered chapters" });
  const headings = page.locator(".tiptap > h1");
  const actions = page.getByRole("button", { name: "Actions for Numbered chapters", exact: true });
  const chapter = name => sidebar.getByRole("button", { name, exact: true });

  async function checkNumbers(expected, visible = expected) {
    for (const label of expected) await chapter(label).waitFor();
    const rows = await sidebar.getByRole("button").evaluateAll(rows => rows.map(row => row.title));
    const editorLabels = (await headings.filter({ visible: true }).allTextContents()).map(text => {
      const [number, title] = text.split("\u00a0");
      return `${number} ${title || "Untitled section"}`;
    });
    assert.deepEqual(rows, expected, "sidebar chapter labels");
    assert.deepEqual(editorLabels, visible, "visible editor chapter labels");
  }

  try {
    await checkNumbers(["1 Introduction", "2 Untitled section", "3 Algorithms"]);
    await headings.nth(1).click();
    await page.keyboard.type("Foundations");
    await checkNumbers(["1 Introduction", "2 Foundations", "3 Algorithms"]);

    // Separate the earlier title edit from the new heading in Yjs history.
    await page.waitForTimeout(550);
    await chapter("3 Algorithms").click();
    const addSection = async () => {
      await actions.click();
      await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
      await chapter("4 Untitled section").waitFor();
    };
    const existing = ["1 Introduction", "2 Foundations", "3 Algorithms"];
    await addSection();
    await checkNumbers([...existing, "4 Untitled section"], ["4 Untitled section"]);
    assert.equal(await chapter("4 Untitled section").getAttribute("aria-current"), "location");
    const inView = await headings.nth(3).evaluate(heading => new Promise(resolve => {
      const observer = new IntersectionObserver(([entry]) => {
        observer.disconnect();
        resolve(entry.isIntersecting);
      });
      observer.observe(heading);
    }));
    assert.equal(inView, true, "the new title is in view");
    await page.keyboard.press("Meta+z");
    await headings.nth(3).waitFor({ state: "detached" });
    await checkNumbers(existing);

    await addSection();
    await page.keyboard.type("Networks");
    await checkNumbers([...existing, "4 Networks"], ["4 Networks"]);
    assert.equal(await chapter("4 Networks").getAttribute("aria-current"), "location");
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

test("Chromium: dragging selected text inside a focused section does not throw", async () => {
  const moduleId = await createModule("Text drag", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId, { sections: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const editor = page.locator(".tiptap");
    const sidebar = page.getByRole("list", { name: "Sections of Text drag" });
    await sidebar.getByRole("button", { name: "2 Middle", exact: true }).click();
    const heading = editor.locator(".section-focus-start");
    const paragraph = editor.getByText("Notes for Middle.", { exact: true });
    await heading.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Shift+End");
    const source = await page.evaluate(() => {
      const selection = getSelection();
      const { x, y, width, height } = selection.getRangeAt(0).getBoundingClientRect();
      return { text: selection.toString(), x: x + width / 2, y: y + height / 2 };
    });
    assert.equal(source.text, "Middle");
    await editor.evaluate(node => {
      node.addEventListener("dragstart", event => {
        node.dataset.trustedDrag = String(event.isTrusted);
      }, { capture: true, once: true });
    });
    const target = await paragraph.boundingBox();
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    // macOS distinguishes a click from a drag of selected text with a short hold.
    if (process.platform === "darwin") await page.waitForTimeout(200);
    await page.mouse.move(target.x + 25, target.y + target.height / 2, { steps: 18 });
    await page.mouse.up();
    assert.equal(await editor.getAttribute("data-trusted-drag"), "true");

    await page.getByRole("link", { name: "Text drag", exact: true }).click();
    assert.equal(await editor.getByText("Notes for Before.", { exact: true }).isVisible(), true);
    assert.equal(await editor.getByText("Notes for After.", { exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
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

async function syncPeerEdit(page, moduleId, edit, { persist = false } = {}) {
  const peer = new Y.Doc();
  try {
    const { state, updates } = await call("get_content", { moduleId });
    Y.applyUpdate(peer, Uint8Array.from(state));
    for (const { bytes } of updates) Y.applyUpdate(peer, Uint8Array.from(bytes));
    const base = Y.encodeStateVector(peer);
    edit(peer.getXmlFragment("default"));
    const bytes = Array.from(Y.encodeStateAsUpdate(peer, base));
    const update = persist ? await call("add_update", { moduleId, bytes }) : { id: 9000, bytes };
    await page.evaluate(async ({ moduleId, update }) => {
      const { onRemote } = await import("/src/lib/sync/apply-remote.ts");
      onRemote({ updates: [{ moduleId, update }], modulesChanged: false,
        deleted: [], reviewsChanged: false, filesChanged: false });
    }, { moduleId, update });
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
  const heading = page.locator(".tiptap > h1").nth(headingIndex);
  const toolbar = page.getByRole("toolbar", { name: "Heading controls" });
  await heading.hover();
  // The toolbar follows the hovered heading asynchronously; clicking before it
  // moves would focus the previous heading's section instead.
  await page.waitForFunction(([target, bar]) => {
    const box = target?.getBoundingClientRect();
    const controls = bar?.getBoundingClientRect();
    return box && controls && controls.bottom > box.top && controls.top < box.bottom;
  }, [await heading.elementHandle(), await toolbar.elementHandle()]);
  await toolbar.getByRole("button", { name: "Focus on this section", exact: true }).click();
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
      node.querySelector("p").firstChild.appendData(" escaped");
      return cancelled;
    });
    assert.equal(cancelled, true);
    await page.evaluate(() => new Promise(requestAnimationFrame));
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
        assert.deepEqual(await visible(), ["3\u00a0Added"]);
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

function createImageSection(name) {
  return createModule(name, ["Before", "Middle", "After"], fragment => {
    fragment.insert(4, [new Y.XmlElement("image")]);
  });
}

test("focused Select All highlights only its section before and after a peer edit", async () => {
  const moduleId = await createImageSection("Image selection");
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    await page.keyboard.press("Meta+a");
    const editor = page.locator(".tiptap");
    const highlights = () => editor.locator(".text-range-selected").allTextContents();
    assert.deepEqual(await highlights(), ["Middle", "Notes for Middle."]);
    await syncPeerEdit(page, moduleId, fragment => fragment.get(3).get(0).insert(0, "Peer edit. "));
    await editor.getByText("Peer edit. Notes for Middle.", { exact: true }).waitFor();
    await page.keyboard.press("Meta+a");
    assert.deepEqual(await highlights(), ["Middle", "Peer edit. Notes for Middle."]);
  } finally {
    await page.close();
  }
});

async function dispatchReplacement(block, { start, end, data, applyDefault = false, cancelable = true }) {
  return block.evaluate((element, { start, end, data, applyDefault, cancelable }) => {
    const text = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    const range = new StaticRange({ startContainer: text, startOffset: start, endContainer: text, endOffset: end });
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable, inputType: "insertReplacementText", data });
    // InputEventInit cannot supply target ranges. Emulate the browser's text
    // mutation over the explicit target range when beforeinput is allowed.
    Object.defineProperty(event, "getTargetRanges", { value: () => [range] });
    if (element.closest(".tiptap").dispatchEvent(event) && applyDefault) {
      text.replaceData(start, end - start, data);
    }
    return event.defaultPrevented;
  }, { start, end, data, applyDefault, cancelable });
}

const gifBytes = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

async function leaveAndReadSaved(page, moduleId) {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.locator(".tiptap").waitFor({ state: "detached" });
  return savedBlocks(moduleId);
}

async function pastePng(page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  await page.keyboard.press("ControlOrMeta+v");
}

for (const method of ["drop", "paste"]) {
  test(`Chromium: an image file ${method} stays after the focused heading in the saved note`, async () => {
    const moduleId = await createModule(`Image file ${method}`, ["Before", "Middle", "After"], fragment => {
      if (method === "paste") fragment.insert(4, [new Y.XmlElement("image")]);
    });
    const page = await openNote(moduleId);
    const directory = await mkdtemp(join(tmpdir(), "memnoter-input-"));
    try {
      await focusMiddleSection(page);
      await page.locator(".tiptap").evaluate((node, method) => {
        node.addEventListener(method, event => { node.dataset.trustedFileEvent = String(event.isTrusted); }, { capture: true, once: true });
      }, method);
      if (method === "drop") {
        const path = join(directory, "new.gif");
        await writeFile(path, Buffer.from(gifBytes, "base64"));
        const { x, y } = await page.locator(".section-focus-start").boundingBox();
        const session = await page.context().newCDPSession(page);
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await session.send("Input.dispatchDragEvent", {
            type, x: x + 1, y: y + 1, data: { items: [], files: [path], dragOperationsMask: 1 },
          });
        }
        await session.detach();
      } else {
        await page.keyboard.press("Meta+a");
        await pastePng(page);
      }
      const editor = page.locator(".tiptap");
      assert.equal(await editor.getAttribute("data-trusted-file-event"), "true");
      await page.waitForFunction(() => document.querySelector(".tiptap").editor.getJSON().content
        .some(node => node.type === "image" && node.attrs.fileId));
      const saved = await leaveAndReadSaved(page, moduleId);
      const middle = saved.findIndex(block => block.endsWith(">Middle</heading>"));
      const after = saved.findIndex(block => block.endsWith(">After</heading>"));
      const uploaded = saved.findIndex(block => block.startsWith("<image ") && block.includes("fileId="));
      assert.ok(uploaded > middle && uploaded < after, JSON.stringify(saved));
    } finally {
      await page.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const moveFocus of [false, true]) {
  test(moveFocus
    ? "Chromium: a pending image upload cannot insert after section focus moves"
    : "Chromium: a pending image upload stays in its section after a peer edits the preceding section", async () => {
    const moduleId = await createModule("Delayed image", ["Before", "Middle", "After"]);
    const uploading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const page = await openNote(moduleId, {
      invoke: async (command, args) => {
        if (command === "save_file") {
          uploading.resolve();
          await release.promise;
        }
        return call(command, args);
      },
    });
    try {
      await focusMiddleSection(page);
      const before = await savedBlocks(moduleId);
      if (!moveFocus) await page.keyboard.press("Meta+a");
      await pastePng(page);
      await uploading.promise;
      if (moveFocus) {
        const toc = page.getByRole("navigation", { name: "Table of contents" });
        await toc.getByRole("button", { name: "2 Middle", exact: true }).hover();
        await toc.getByRole("button", { name: "Unfocus Middle", exact: true }).press("Enter");
        await toc.getByRole("button", { name: "1 Before", exact: true }).hover();
        await toc.getByRole("button", { name: "Focus on Before", exact: true }).press("Enter");
        await page.locator(".section-focus-start").filter({ hasText: "Before" }).waitFor();
      } else {
        await syncPeerEdit(page, moduleId, fragment => fragment.get(1).get(0).insert(0, "Peer edit. "), { persist: true });
        await page.locator(".tiptap > p").filter({ hasText: /^Peer edit\. Notes for Before\.$/ }).waitFor({ state: "attached" });
      }
      release.resolve();
      const discard = page.getByRole("button", { name: "Discard failed image operations" });
      const inserted = page.locator(".tiptap .note-image-host");
      await discard.or(inserted).first().waitFor({ state: "attached" });
      assert.equal(await discard.isVisible(), moveFocus);
      if (moveFocus) await discard.click();
      else await page.locator(".section-focus-start").filter({ hasText: "Middle" }).waitFor();

      const saved = await leaveAndReadSaved(page, moduleId);
      if (moveFocus) {
        assert.deepEqual(saved, before);
      } else {
        assert.match(saved[3], /^<image .*fileId=/);
        assert.deepEqual(saved.filter((_, i) => i !== 3), [
          before[0], "<paragraph>Peer edit. Notes for Before.</paragraph>", ...before.slice(2),
        ]);
      }
    } finally {
      release.resolve();
      await page.close();
    }
  });
}

for (const sections of [true, false]) {
  test(`Chromium: a pending image pasted at a focused title stays before a peer's new chapter (${sections ? "sidebar" : "Contents"})`, async () => {
    const name = "Chapter boundary image";
    const moduleId = await createModule(name, ["Before", "Middle", "After"], fragment => fragment.delete(3, 1));
    const uploading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const page = await openNote(moduleId, {
      sections,
      invoke: async (command, args) => {
        if (command === "save_file") {
          uploading.resolve();
          await release.promise;
        }
        return call(command, args);
      },
    });
    try {
      if (sections) {
        await page.getByRole("list", { name: `Sections of ${name}` })
          .getByRole("button", { name: "2 Middle", exact: true }).click();
      } else {
        const contents = page.getByRole("navigation", { name: "Table of contents" });
        await contents.getByRole("button", { name: "2 Middle", exact: true }).hover();
        await contents.getByRole("button", { name: "Focus on Middle", exact: true }).press("Enter");
      }
      const focused = page.locator(".tiptap > h1.section-focus-start").filter({ hasText: "Middle" });
      await focused.click();
      // macOS Chromium scrolls on Home; Cmd+Left moves to the start of the line.
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
      assert.equal(await focused.evaluate(node => {
        const { selection } = node.parentElement.editor.state;
        return selection.empty && selection.$from.parentOffset === 0;
      }), true, "caret at the start of the focused title");
      await pastePng(page);
      await uploading.promise;
      await syncPeerEdit(page, moduleId, fragment => {
        const heading = new Y.XmlElement("heading");
        heading.setAttribute("level", 1);
        heading.setAttribute("data-toc-id", "peer-chapter");
        heading.setAttribute("id", "peer-chapter");
        const title = new Y.XmlText();
        title.insert(0, "Peer chapter");
        heading.insert(0, [title]);
        fragment.insert(3, [heading]);
      }, { persist: true });
      await page.locator(".tiptap > h1").filter({ hasText: "Peer chapter" }).waitFor({ state: "attached" });
      await focused.waitFor();
      const beforeImage = await savedBlocks(moduleId);
      release.resolve();
      const discard = page.getByRole("button", { name: "Discard failed image operations" });
      const image = page.locator(".tiptap .note-image-host");
      await discard.or(image).first().waitFor();
      assert.equal(await discard.isVisible(), false, "image upload reported a failed operation");
      await focused.waitFor();
      const saved = await leaveAndReadSaved(page, moduleId);
      assert.match(saved[3], /^<image .*fileId=/);
      assert.deepEqual(saved.filter((_, i) => i !== 3), beforeImage);
    } finally {
      release.resolve();
      await page.close();
    }
  });
}

for (const schedule of ["microtask", "timer"]) {
  test(`Chromium: a programmatic edit queued as a ${schedule} from trusted input reveals its hidden heading`, async () => {
    const moduleId = await createModule("Queued programmatic edit", ["Before", "Middle", "After"]);
    const page = await openNote(moduleId);
    try {
      await focusMiddleSection(page);
      const editor = page.locator(".tiptap");
      await editor.evaluate((node, schedule) => {
        node.addEventListener("input", event => {
          if (!event.isTrusted) return;
          const { editor } = node;
          const edit = () => editor.view.dispatch(editor.state.tr.insertText("Updated ", 1));
          if (schedule === "microtask") queueMicrotask(edit);
          else setTimeout(edit, 0);
        }, { once: true });
      }, schedule);
      await page.keyboard.type("x");
      await editor.locator(":scope > h1").filter({ hasText: "Updated Before" }).waitFor({ timeout: 3000 });
      assert.equal(await editor.locator(".section-focus-start").count(), 0);
      const saved = await leaveAndReadSaved(page, moduleId);
      assert.match(saved[0], />Updated Before<\/heading>$/);
    } finally {
      await page.close();
    }
  });
}

test("the input backstop keeps hidden edits from DOM events and observers out of the saved note", async () => {
  const moduleId = await createModule("Raw input boundary", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    const before = await savedBlocks(moduleId);
    const editor = page.locator(".tiptap");
    const escaped = [];
    await focusMiddleSection(page);
    for (const input of ["keydown", "insertText", "insertReplacementText", "deleteContentBackward", "deleteContentForward",
      "compositionstart", "compositionupdate", "compositionend", "paste", "drop", "cut", "mutation"]) {
      await editor.evaluate((node, input) => {
        const { editor } = node;
        const hidden = node.querySelector("p").firstChild;
        if (input === "mutation") {
          hidden.appendData(" escaped");
          return;
        }
        const init = { bubbles: true, cancelable: true };
        const event = input === "keydown" ? new KeyboardEvent(input, { ...init, key: "F8" })
          : input.startsWith("composition") ? new CompositionEvent(input, init)
          : input === "paste" || input === "cut" ? new ClipboardEvent(input, init)
          : input === "drop" ? new DragEvent(input, init)
          : new InputEvent("beforeinput", { ...init, inputType: input, data: "escaped" });
        // Stand in for an editor handler that computed a bad destination despite
        // the valid visible caret. No input metadata is attached to its edit.
        const { view } = editor;
        const { handleDOMEvents } = view.props;
        view.setProps({ handleDOMEvents: {
          ...handleDOMEvents,
          [event.type]: () => {
            const pos = view.posAtDOM(hidden, 0);
            view.dispatch(editor.state.tr.insertText("escaped ", pos));
            return true;
          },
        } });
        try { node.dispatchEvent(event); }
        finally { view.setProps({ handleDOMEvents }); }
      }, input);
      // Let the observer reconcile an actual DOM mutation before reading the editor.
      await page.evaluate(() => new Promise(requestAnimationFrame));
      if (await editor.locator(":scope > p").first().textContent() !== "Notes for Before.") escaped.push(input);
      if (escaped.length) break;
    }
    const saved = await leaveAndReadSaved(page, moduleId);
    assert.deepEqual({ escaped, saved }, { escaped: [], saved: before });
  } finally {
    await page.close();
  }
});

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine}: an image drop before the focused heading neither previews nor moves the image`, async () => {
    const moduleId = await createModule("Image drop boundary", ["Before", "Middle", "After"], fragment => {
      const image = new Y.XmlElement("image");
      image.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
      image.setAttribute("width", 100);
      image.setAttribute("height", 100);
      fragment.insert(4, [image]);
    });
    const page = await openNote(moduleId, { engine });
    try {
      await focusMiddleSection(page);
      const before = await savedBlocks(moduleId);
      const image = page.locator(".tiptap .note-image-host img");
      await image.waitFor();
      const box = await image.boundingBox();
      const heading = await page.locator(".section-focus-start").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(heading.x + 1, heading.y + 1, { steps: 10 });
      await page.locator("[data-moving]").waitFor();
      const markerVisible = await page.locator(".note-image-drop-indicator").isVisible();
      await page.mouse.up();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.locator(".tiptap").waitFor({ state: "detached" });
      const saved = await savedBlocks(moduleId);
      assert.deepEqual({ markerVisible, saved }, { markerVisible: false, saved: before });
    } finally {
      await page.close();
    }
  });

  test(`${engine}: replacement text cannot write to a hidden code target from a visible caret`, async () => {
    const moduleId = await createModule("Hidden code target", ["Before", "Middle", "After"], fragment => {
      const code = new Y.XmlElement("codeBlock");
      const text = new Y.XmlText();
      text.insert(0, "value ");
      code.insert(0, [text]);
      fragment.insert(2, [code]);
    });
    const page = await openNote(moduleId, { engine });
    try {
      await focusMiddleSection(page);
      const prevented = await dispatchReplacement(page.locator(".tiptap pre code"), { start: 5, end: 6, data: ". " });
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.locator(".tiptap").waitFor({ state: "detached" });
      const code = (await savedBlocks(moduleId)).find(block => block.startsWith("<codeblock"));
      assert.equal(prevented, true);
      assert.match(code, />value <\/codeblock>$/);
    } finally {
      await page.close();
    }
  });

  test(`${engine}: noncancelable replacement restores hidden DOM and leaves saved Yjs unchanged`, async () => {
    const moduleId = await createModule("Native hidden mutation", ["Before", "Middle", "After"]);
    const page = await openNote(moduleId, { engine });
    try {
      await focusMiddleSection(page);
      const before = await savedBlocks(moduleId);
      const hidden = page.locator(".tiptap > p").first();
      await dispatchReplacement(hidden, { start: 0, end: 5, data: "Hidden edit", applyDefault: true, cancelable: false });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const rendered = await hidden.textContent();
      const saved = await leaveAndReadSaved(page, moduleId);
      assert.deepEqual({ rendered, saved }, { rendered: "Notes for Before.", saved: before });
    } finally {
      await page.close();
    }
  });

  test(`${engine}: replacement text after focused Select All edits only its explicit word target`, async () => {
    const moduleId = await createImageSection("Replace image selection");
    const page = await openNote(moduleId, { engine });
    try {
      await focusMiddleSection(page);
      const before = await savedBlocks(moduleId);
      await page.keyboard.press("Meta+a");
      const block = page.locator(".tiptap > p").filter({ hasText: "Notes for Middle." });
      const prevented = await dispatchReplacement(block, { start: 0, end: "Notes".length, data: "Details", applyDefault: true });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const saved = await leaveAndReadSaved(page, moduleId);
      assert.deepEqual({ prevented, saved }, {
        prevented: false,
        saved: [...before.slice(0, 3), "<paragraph>Details for Middle.</paragraph>", ...before.slice(4)],
      });
    } finally {
      await page.close();
    }
  });
}

test("Chromium: input-only insertText after focused Select All keeps hidden sections unchanged", async () => {
  const moduleId = await createImageSection("Input-only image selection");
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const before = await savedBlocks(moduleId);
    await page.keyboard.press("Meta+a");
    const inputEvents = await page.locator(".tiptap").evaluate(node => {
      const events = [];
      const record = event => events.push([event.type, event.inputType]);
      node.addEventListener("beforeinput", record);
      node.addEventListener("input", record);
      try {
        document.execCommand("insertText", false, "Revised section");
        return events;
      } finally {
        node.removeEventListener("beforeinput", record);
        node.removeEventListener("input", record);
      }
    });
    assert.deepEqual(inputEvents, [["input", "insertText"]]);
    await page.getByText("Revised section", { exact: true }).waitFor();
    const saved = await leaveAndReadSaved(page, moduleId);
    assert.deepEqual(saved.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(saved.slice(-2), before.slice(-2));
    assert.equal(saved.slice(2, -2).filter(block => block.includes(">Revised section<")).length, 1);
  } finally {
    await page.close();
  }
});

test("WebKit: Enter confirms a focused Select All composition without adding a paragraph", async () => {
  const moduleId = await createImageSection("IME confirmation");
  const page = await openNote(moduleId, { engine: "WebKit" });
  try {
    await focusMiddleSection(page);
    const before = await savedBlocks(moduleId);
    await page.keyboard.press("Meta+a");
    const editor = page.locator(".tiptap");
    await editor.dispatchEvent("compositionstart", { bubbles: true, cancelable: true });
    await editor.dispatchEvent("compositionupdate", { bubbles: true, cancelable: true, data: "に" });
    await page.keyboard.insertText("日本");
    await editor.evaluate(node => {
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
      // The IME consumes the browser's default Enter action on confirmation.
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    });
    await page.getByText("日本", { exact: true }).waitFor();
    const saved = await leaveAndReadSaved(page, moduleId);
    assert.deepEqual(saved.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(saved.slice(-2), before.slice(-2));
    const edited = saved.slice(2, -2).filter(block => !block.startsWith("<image"));
    assert.deepEqual(edited.map(block => block.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "")), ["日本"]);
  } finally {
    await page.close();
  }
});

for (const all of [false, true]) {
  test(all ? "Replace All reveals the whole note before editing hidden matches" : "Replace reveals a hidden current match before changing it", async () => {
    const name = all ? "Replace all sections" : "Replace in sections";
    const moduleId = await createModule(name, ["Before", "Middle", "After"]);
    const page = await openNote(moduleId, { sections: true });
    try {
      await page.keyboard.press("Meta+Alt+f");
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("Notes for");
      await page.getByRole("textbox", { name: "Replace with" }).fill("Summary of");
      await page.getByText("Match 1 of 3", { exact: true }).waitFor();
      await page.getByRole("list", { name: `Sections of ${name}` })
        .getByRole("button", { name: "2 Middle", exact: true }).click();
      const editor = page.locator(".tiptap");
      await editor.locator(".section-focus-start").waitFor();
      const replace = page.getByRole("button", { name: all ? "Replace all" : "Replace", exact: true });
      // Observe what is visible at the first write, before any follow-up reveal.
      await editor.evaluate(element => {
        element.editor.on("beforeTransaction", ({ transaction }) => {
          if (transaction.docChanged && !("focusedAtReplace" in element.dataset)) {
            element.dataset.focusedAtReplace = String(element.classList.contains("section-focused"));
          }
        });
      });
      await replace.click();
      if (!all) {
        await editor.locator(":scope > h1").first().waitFor();
        assert.equal(await editor.locator(":scope > p").first().textContent(), "Notes for Before.");
        await replace.click();
      }
      assert.equal(await editor.getAttribute("data-focused-at-replace"), "false");
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      assert.deepEqual((await savedBlocks(moduleId)).filter(block => block.startsWith("<paragraph")).map(block => block.replace(/<[^>]+>/g, "")),
        ["Summary of Before.", all ? "Summary of Middle." : "Notes for Middle.", all ? "Summary of After." : "Notes for After."]);
    } finally {
      await page.close();
    }
  });
}

test("a closed untitled section click follows its heading when a peer inserts an earlier chapter", async () => {
  const name = "Untitled during sync";
  const moduleId = await createModule(name, ["First", "", "Last"]);
  const { promise: readStarted, resolve: startRead } = Promise.withResolvers();
  const { promise: releaseRead, resolve: finishRead } = Promise.withResolvers();
  let loading = false;
  const page = await openNote(course, { sections: true, async invoke(command, args) {
    if (command === "get_content" && args.moduleId === moduleId && loading) {
      startRead();
      await releaseRead;
    }
    return call(command, args);
  } });
  try {
    await page.getByRole("button", { name: `Expand sections of ${name}` }).click();
    const row = page.getByRole("list", { name: `Sections of ${name}` })
      .getByRole("button", { name: "2 Untitled section", exact: true });
    await row.waitFor();
    loading = true;
    await row.click();
    const editor = page.locator(".tiptap");
    await readStarted;
    await syncPeerEdit(page, moduleId, fragment => {
      const heading = new Y.XmlElement("heading");
      heading.setAttribute("level", 1);
      const text = new Y.XmlText();
      text.insert(0, "Peer chapter");
      heading.insert(0, [text]);
      fragment.insert(0, [heading]);
    }, { persist: true });
    finishRead();
    await editor.locator(".section-focus-start").waitFor();
    assert.deepEqual(await editor.locator(":scope > h1:visible").allTextContents(), ["3\u00a0"]);
    assert.equal(await editor.getByText("An unfinished chapter.", { exact: true }).isVisible(), true);
  } finally {
    finishRead();
    await page.close();
  }
});
