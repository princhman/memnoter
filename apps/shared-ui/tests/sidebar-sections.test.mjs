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
  async function openModule(name) {
    await module(name).click({ delay: 60 });
    await page.locator(".tiptap[contenteditable=true]").waitFor();
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

    await pickUp(reference);
    await hoverRow(archived.getByRole("button", { name: "2 Appendix", exact: true }), 0.8);
    await page.mouse.up();
    await archived.getByRole("button", { name: "2 Reference", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/${course}`, "reordering a closed note leaves the active note open");
    const saved = await call("get_content", { moduleId: archive });
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Uint8Array.from(saved.state));
      for (const update of saved.updates) Y.applyUpdate(doc, Uint8Array.from(update.bytes));
      assert.deepEqual(doc.getXmlFragment("default").toArray()
        .filter(node => node.nodeName === "heading").map(node => node.get(0).toString()), ["Appendix", "Reference"]);
    } finally {
      doc.destroy();
    }
    await openModule("Archive");
    await checkNumbers(archived, ["1 Appendix", "2 Reference"]);

    await chapter("3 Algorithms").click();
    assert.deepEqual(await renderedHeadings.filter({ visible: true }).allTextContents(), ["3\u00a0Algorithms"]);
    await module("Computing").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add section", exact: true }).click();
    await page.keyboard.type("Networks");
    await checkNumbers(computing, [...initial, "6 Networks"]);
  } finally {
    await page.close();
  }
});
