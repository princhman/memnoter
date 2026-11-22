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

async function createModule(name, titles) {
  const moduleId = await call("create_module", { name });
  const doc = new Y.Doc();
  doc.getXmlFragment("default").insert(0, titles.flatMap((title, index) => {
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

async function openNote(moduleId, { sections = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1150, height: 750 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => console.error(error));
  await page.context().route("https://api.github.com/repos/princhman/memnoter/releases/latest",
    route => route.fulfill({ status: 404, json: {} }));
  await page.exposeFunction("coreCall", call);
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
    const composing = await editor.evaluate(node => {
      const { editor } = node;
      const first = editor.state.doc.firstChild;
      editor.commands.setTextSelection({ from: first.nodeSize - 2, to: editor.state.doc.content.size - 2 });
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      return editor.view.composing;
    });
    assert.equal(composing, true);
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
