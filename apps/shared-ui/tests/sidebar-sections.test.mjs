import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as Y from "yjs";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const { createServer } = browserHarness(import.meta.url);
const workspace = fileURLToPath(new URL("../../..", import.meta.url));
let server, browser, core, course, archive;
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
  await server?.close();
  if (core && core.exitCode === null) {
    const exited = once(core, "exit");
    core.stdin.end();
    await exited;
  }
});

async function openNote(moduleId, { sections = false, invoke = call } = {}) {
  const page = await browser.newPage({ viewport: { width: 1150, height: 750 } });
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

test("numbered chapters match in the sidebar and editor after reordering within a note and back", async () => {
  const page = await openNote(course, { sections: true });
  const computing = page.getByRole("list", { name: "Sections of Computing" });
  const archived = page.getByRole("list", { name: "Sections of Archive" });
  const module = name => page.getByRole("link", { name, exact: true });
  const renderedHeadings = page.locator(".tiptap > h1");
  const initial = ["1 Introduction", "2 Untitled section", "3 Algorithms", "4 Data structures", "5 Complexity"];
  const reordered = ["1 Introduction", "2 Algorithms", "3 Untitled section", "4 Data structures", "5 Complexity"];

  async function checkNumbers(sidebar, expected) {
    await sidebar.getByRole("button", { name: expected.at(-1), exact: true }).waitFor();
    const rows = await sidebar.getByRole("button").evaluateAll(rows =>
      rows.map(row => [...row.children].map(child => child.textContent).join(" ")));
    const headings = await renderedHeadings.filter({ visible: true }).evaluateAll(nodes => nodes.map(node => {
      const number = node.querySelector(".heading-number")?.textContent.trim();
      const title = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
        .map(child => child.textContent).join("").trim() || "Untitled section";
      return `${number} ${title}`;
    }));
    assert.deepEqual(rows, expected, "sidebar chapter labels");
    assert.deepEqual(headings, rows, "editor chapter labels");
  }

  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function pickUp(row) {
    const box = await row.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 8, { steps: 4 });
    const preview = page.locator("[data-sidebar-drag-preview]");
    await preview.waitFor();
    const labels = locator => locator.evaluate(node => [...node.children].map(child => child.textContent));
    assert.deepEqual(await labels(preview), await labels(row), "preview preserves separate chapter number and title");
    assert.ok((await preview.boundingBox()).width >= box.width - 1);
  }
  async function hoverRow(row, fraction = 0.5) {
    const box = await row.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction, { steps: 12 });
    await frames();
  }
  try {
    await checkNumbers(computing, initial);
    const chapter = name => computing.getByRole("button", { name, exact: true });
    await pickUp(chapter("3 Algorithms"));
    await hoverRow(chapter("2 Untitled section"), 0.2);
    await page.mouse.up();
    await checkNumbers(computing, reordered);

    await pickUp(chapter("2 Algorithms"));
    await hoverRow(chapter("3 Untitled section"), 0.8);
    await page.mouse.up();
    await checkNumbers(computing, initial);

    const archiveBefore = await call("get_content", { moduleId: archive });
    const archiveDisclosure = page.getByRole("button", { name: /^(Expand|Collapse) sections of Archive$/ });
    assert.equal(await archived.count(), 0);
    await pickUp(chapter("3 Algorithms"));
    await hoverRow(module("Archive"));
    await page.waitForTimeout(2200);
    assert.equal(await archiveDisclosure.getAttribute("aria-expanded"), "false", "hovering a different module during a section drag keeps it collapsed");
    await page.mouse.up();
    await frames();
    await checkNumbers(computing, initial);

    await archiveDisclosure.click();
    const reference = archived.getByRole("button", { name: "1 Reference", exact: true });
    await reference.waitFor();
    await pickUp(chapter("3 Algorithms"));
    await hoverRow(reference, 0.8);
    assert.equal(await reference.locator("..").locator("span[aria-hidden=true]").count(), 0, "another module's rows show no insertion marker");
    await page.mouse.up();
    await frames();
    await checkNumbers(computing, initial);
    assert.deepEqual(await archived.getByRole("button").allTextContents(), ["1Reference", "2Appendix"]);
    assert.deepEqual(await call("get_content", { moduleId: archive }), archiveBefore, "a rejected drop leaves the other note untouched");

    await chapter("3 Algorithms").click();
    assert.deepEqual(await renderedHeadings.filter({ visible: true }).allTextContents(), ["3\u00a0Algorithms"]);
    await pickUp(chapter("3 Algorithms"));
    await hoverRow(chapter("2 Untitled section"), 0.2);
    await page.mouse.up();
    await chapter("2 Algorithms").waitFor();
    assert.deepEqual(await renderedHeadings.filter({ visible: true }).allTextContents(), ["2\u00a0Algorithms"]);
    await page.locator(".tiptap > .section-focus-start").click();
    await page.keyboard.press("Meta+z");
    await chapter("3 Algorithms").waitFor();
    await chapter("3 Algorithms").click();
    await module("Computing").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
    await page.keyboard.type("Networks");
    await checkNumbers(computing, [...initial, "6 Networks"]);
  } finally {
    await page.close();
  }
});

test("a closed section cannot be dragged until its note is open", async () => {
  const page = await openNote(course, { sections: true });
  const disclosure = page.getByRole("button", { name: "Expand sections of Archive" });
  const rows = page.getByRole("list", { name: "Sections of Archive" }).getByRole("button");
  const original = await call("get_content", { moduleId: archive });
  const moveTo = async (row, fraction) => {
    const box = await row.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction, { steps: 15 });
  };
  try {
    await disclosure.click();
    await rows.last().waitFor();
    await moveTo(rows.first(), 0.5);
    await page.mouse.down();
    await moveTo(rows.last(), 0.8);
    assert.equal(await page.locator("[data-sidebar-drag-preview]").count(), 0);
    await page.mouse.up();
    assert.deepEqual(await call("get_content", { moduleId: archive }), original);
    assert.equal(new URL(page.url()).pathname, `/${course}`);

    await page.getByRole("link", { name: "Archive", exact: true }).click();
    await page.locator(".tiptap > h1").filter({ hasText: "Appendix" }).waitFor();
    await page.locator(".tiptap[contenteditable=true]").waitFor();
    await moveTo(rows.first(), 0.5);
    await page.mouse.down();
    await moveTo(rows.last(), 0.8);
    await page.locator("[data-sidebar-drag-preview]").waitFor();
    await page.mouse.up();
    await rows.first().filter({ hasText: "Appendix" }).waitFor();
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

test("a closed note's legacy untitled section opens in section focus", async () => {
  const moduleId = await createModule("Untitled chapters", ["First", "", "Last"]);
  const page = await openNote(course, { sections: true });
  try {
    await page.getByRole("button", { name: "Expand sections of Untitled chapters" }).click();
    const rows = page.getByRole("list", { name: "Sections of Untitled chapters" });
    await rows.getByRole("button", { name: "2 Untitled section", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, `/${moduleId}`);
    await page.locator(".tiptap > .section-focus-start").waitFor({ timeout: 3000 });
    assert.deepEqual(await page.locator(".tiptap > h1").filter({ visible: true }).allTextContents(), ["2\u00a0"]);
    await page.getByRole("link", { name: "Untitled chapters", exact: true }).click();
    await page.locator(".tiptap.section-focused").waitFor({ state: "detached" });
    assert.equal(await page.locator(".tiptap > h1").filter({ visible: true }).count(), 3);
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

function selectAcrossHiddenSections(node) {
  const { editor } = node;
  editor.commands.setTextSelection({
    from: editor.state.doc.firstChild.nodeSize - 2,
    to: editor.state.doc.content.size - 2,
  });
}

test("typing, cut and Markdown paste keep hidden text when the selection spans chapters", async () => {
  const moduleId = await createModule("Input boundary", ["Before", "Middle", "After"]);
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    const editor = page.locator(".tiptap");
    const snapshot = () => editor.evaluate(({ editor }) => editor.getJSON());
    const before = await snapshot();
    await editor.evaluate(selectAcrossHiddenSections);
    await page.keyboard.insertText("Replacement");
    assert.deepEqual(await snapshot(), before);
    for (const type of ["cut", "paste"]) {
      await editor.evaluate(selectAcrossHiddenSections);
      await editor.evaluate((node, type) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "# Markdown heading\n\n- list item");
        node.dispatchEvent(new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true }));
      }, type);
      assert.deepEqual(await snapshot(), before);
    }
  } finally {
    await page.close();
  }
});

test("section focus rejects a composing Delete across hidden sections before it reaches Yjs", async () => {
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
    // A native selection can escape the focused range independently of the
    // app's Select All shortcut. Establish it before the composing keydown.
    await editor.evaluate(selectAcrossHiddenSections);
    const cancelled = await editor.evaluate(node => {
      return !node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, cancelable: true }));
    });
    assert.equal(cancelled, true);
    await page.keyboard.press("Delete");
    await editor.evaluate(async node => {
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    assert.deepEqual(await snapshot(), before);
  } finally {
    await page.close();
  }
});

test("a section move keeps offline edits in the drop target and untouched chapter", async () => {
  const moduleId = await createModule("Concurrent chapters", ["First", "Second", "Third"]);
  const page = await openNote(moduleId, { sections: true });
  const peer = new Y.Doc();
  try {
    const { state, updates } = await call("get_content", { moduleId });
    Y.applyUpdate(peer, Uint8Array.from(state));
    for (const { bytes } of updates) Y.applyUpdate(peer, Uint8Array.from(bytes));
    const base = Y.encodeStateVector(peer);
    const fragment = peer.getXmlFragment("default");
    for (const [index, edit] of [[3, " Target peer edit."], [5, " Untouched peer edit."]]) {
      const text = fragment.get(index).get(0);
      text.insert(text.length, edit);
    }
    const sidebar = page.getByRole("list", { name: "Sections of Concurrent chapters" });
    const first = sidebar.getByRole("button", { name: "1 First" });
    const second = sidebar.getByRole("button", { name: "2 Second" });
    await first.click();
    const source = await first.boundingBox();
    const target = await second.boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.8, { steps: 15 });
    await page.locator("[data-sidebar-drag-preview]").waitFor();
    await page.mouse.up();
    await sidebar.getByRole("button", { name: "2 First" }).waitFor();

    const editor = page.locator(".tiptap");
    const moved = await editor.evaluate(async ({ editor }, bytes) => {
      const doc = editor.extensionManager.extensions.find(ext => ext.name === "collaboration").options.document;
      const { applySavedContent } = await import("/src/lib/content.ts");
      applySavedContent(doc, { state: [], updates: [{ id: 1, bytes }], files: [] });
      return doc.getXmlFragment("default").toArray().map(block => block.get(0)?.toString());
    }, Array.from(Y.encodeStateAsUpdate(peer, base)));
    assert.deepEqual(moved, ["Second", "Notes for Second. Target peer edit.", "First", "Notes for First.", "Third", "Notes for Third. Untouched peer edit."]);
    assert.deepEqual(await editor.locator(":scope > h1").filter({ visible: true }).allTextContents(), ["2\u00a0First"]);
  } finally {
    peer.destroy();
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

test("a blocked Add section cannot insert on Back, and a fresh request can add across notes", async () => {
  const a = await createModule("Save source", ["Before"]);
  const b = await createModule("Add destination", ["Existing"]);
  let failing = false;
  const page = await openNote(b, { sections: true, invoke(command, args) {
    if (failing && command === "sync_cards" && args.moduleId === a) throw new Error("test card save failure");
    return call(command, args);
  } });
  const editor = page.locator(".tiptap[contenteditable=true]");
  const destination = page.getByRole("link", { name: "Add destination", exact: true });
  const add = async () => {
    await destination.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
  };
  try {
    await page.getByRole("link", { name: "Save source", exact: true }).click();
    await editor.getByText("Notes for Before.", { exact: true }).waitFor();
    failing = true;
    await editor.locator(":scope > p").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Prompt :: answer");
    const blocked = page.waitForEvent("dialog");
    const attempted = add();
    const dialog = await blocked;
    assert.match(dialog.message(), /Could not save flashcards/);
    await dialog.accept();
    await attempted;
    assert.equal(new URL(page.url()).pathname, `/${a}`);

    failing = false;
    await page.evaluate(() => history.back());
    await editor.getByText("Notes for Existing.", { exact: true }).waitFor();
    assert.equal(await editor.locator(":scope > h1").count(), 1);

    await page.getByRole("link", { name: "Save source", exact: true }).click();
    await page.waitForURL(`**/${a}`);
    await editor.locator(":scope > p").filter({ hasText: "Prompt" }).waitFor();
    await add();
    await editor.locator(":scope > h1").nth(1).waitFor();
    await page.keyboard.type("Added");
    assert.deepEqual(await editor.locator(":scope > h1").allTextContents(), ["1\u00a0Existing", "2\u00a0Added"]);
  } finally {
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

test("focused Select All includes a trailing block image without selecting the next chapter", async () => {
  const moduleId = await createModule("Image selection", ["Before", "Middle", "After"], fragment => {
    fragment.insert(4, [new Y.XmlElement("image")]);
  });
  const page = await openNote(moduleId);
  try {
    await focusMiddleSection(page);
    await page.keyboard.press("Meta+a");
    const selected = await page.locator(".tiptap").evaluate(({ editor }) =>
      editor.state.selection.content().content.toJSON().map(node => node.type));
    assert.deepEqual(selected, ["heading", "paragraph", "image"]);
    const highlights = await page.locator(".tiptap .text-range-selected").allTextContents();
    assert.deepEqual(highlights, ["Middle", "Notes for Middle."]);
    await page.keyboard.press("Backspace");
    const remaining = await page.locator(".tiptap > h1").allTextContents();
    assert.deepEqual(remaining, ["1\u00a0Before", "2\u00a0After"]);
  } finally {
    await page.close();
  }
});
