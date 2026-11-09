import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, child;
const pending = [];
const schedule = { ord: 0, kind: "review", suspended: false, intervalDays: 3, ease: 2.5, reps: 2, lapses: 0, due: 1800000000000, reviews: [{ time: 1700000000000, rating: 3 }, { time: 1700086400000, rating: 4 }] };
const pkg = { decks: [{ id: 1, name: "Course", cardCount: 0 }, { id: 2, name: "Course::A", cardCount: 1 }, { id: 3, name: "Course::B", cardCount: 1 }],
  media: [], warnings: [], items: [2, 3].map(deckId => ({ noteId: deckId, deckId, notetype: "Basic", kind: "basic", front: "Q", back: "A", extra: "", reversed: false, cards: [schedule] })) };
const session = { sourceId: "test-source", fileName: "test.apkg", package: pkg };
before(async () => {
  const workspace = fileURLToPath(new URL("../../..", import.meta.url));
  execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], { cwd: workspace, stdio: "pipe" });
  child = spawn(`${workspace}/target/debug/examples/command-harness`, [], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  const root = fileURLToPath(new URL("..", import.meta.url));
  server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
});
after(async () => {
  await browser?.close(); await server?.close();
  if (child) { child.stdin.end(); await new Promise(resolve => child.on("exit", resolve)); }
});
async function open(failAt = 0) {
  let imports = 0;
  const page = await browser.newPage({ viewport: { width: 500, height: 750 } });
  await page.exposeFunction("rustCall", async (command, args = {}) => {
    if (command === "import_module" && ++imports === failAt) throw new Error("Disk write failed");
    const result = await new Promise(resolve => { pending.push(resolve); child.stdin.write(JSON.stringify({ command, args }) + "\n"); });
    if (result.error) throw new Error(result.error.message ?? result.error);
    return result.value;
  });
  await page.exposeFunction("pickAnki", () => session);
  await page.addInitScript(() => {
    window.closedSessions = [];
    window.installTestBridge({ tauri: { invoke: (command, args) => {
      if (command === "pick_anki_package") return window.pickAnki();
      if (command === "close_anki_package") { window.closedSessions.push(args.sourceId); return Promise.resolve(); }
      return window.rustCall(command, args);
    } } });
  });
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/anki-dialog.html`);
  await page.waitForFunction(() => !!window.prepareAnkiImport);
  await page.evaluate(() => window.dispatchEvent(new Event("memnoter-import-anki")));
  await page.getByRole("dialog").waitFor();
  return page;
}
test("deck roles, name validation, cancellation and session release save nothing before Import", async () => {
  const page = await open();
  try {
    assert.equal(await page.getByRole("combobox", { name: "Role for Course::A", exact: true }).inputValue(), "module");
    // Each deck is one row: its name, card count and role share a line, and a deck with
    // subdecks folds them away.
    const row = page.getByText("A 1 card", { exact: true });
    assert.equal(await row.count(), 1);
    const [rowBox, roleBox] = await Promise.all([row.boundingBox(), page.getByRole("combobox", { name: "Role for Course::A", exact: true }).boundingBox()]);
    assert.ok(Math.abs((rowBox.y + rowBox.height / 2) - (roleBox.y + roleBox.height / 2)) < 4, "name and role are on one line");
    await page.getByRole("button", { name: "Collapse Course", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Role for Course::A", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Expand Course", exact: true }).click();
    await page.getByRole("combobox", { name: "Role for Course::A", exact: true }).waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const names = page.getByLabel("Module name", { exact: true });
    await names.nth(0).fill("");
    assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
    await names.nth(0).fill("B");
    assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => call("modules")), []);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => window.closedSessions.length === 1);
    assert.deepEqual(await page.evaluate(() => call("modules")), []);
  } finally { await page.close(); }
});
test("real commit creates modules, reuses sidebar folder, imports review history and suffixes names", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByText("Imported 2 modules and 2 cards.", { exact: true }).waitFor();
    // The result is a real Sonner toast, not a hand-made popup.
    assert.equal(await page.locator("[data-sonner-toast]", { hasText: "Imported 2 modules and 2 cards." }).count(), 1);
    const stored = await page.evaluate(async () => {
      const modules = await call("modules");
      const cards = await call("due_cards", { moduleId: null, now: 2000000000000, createdBefore: null });
      return { modules, cards, sidebar: await call("sidebar_items") };
    });
    assert.equal(stored.modules.length, 2);
    assert.equal(stored.cards.length, 2);
    assert.ok(stored.cards.every(c => c.reps === 2 && c.lastReviewAt === 1700086400000 && c.fsrsModel === "fsrs-7"));
    const folders = stored.sidebar.filter(i => i.name !== null);
    assert.equal(folders.length, 1);
    assert.equal(folders[0].name, "Course");
    assert.ok(stored.sidebar.filter(i => i.name === null).every(i => i.folder_id === folders[0].id));
    const names = await page.evaluate(async session => {
      const plan = prepareAnkiImport(session.package, defaultSelection(session.package.decks));
      const result = await importAnki(session, plan, () => {});
      return result.modules.map(m => m.name);
    }, session);
    assert.deepEqual(names, ["A 2", "B 2"]);
  } finally { await page.close(); }
});

test("canvas preserves text labels, leaves unlabelled bytes untouched and warns if drawing is unavailable", async () => {
  const page = await open();
  try {
    const result = await page.evaluate(async () => {
      const { bakeAnkiLabels } = await import("/src/lib/anki-labels.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 100;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 200, 100);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const bytes = [...new Uint8Array(await blob.arrayBuffer())];
      const warnings = [];
      const labels = [{ text: "LABEL", x: .1, y: .5, size: .3, color: "#ff0000" }];
      const plain = await bakeAnkiLabels(bytes, "image/png", [], w => warnings.push(w));
      const labelled = await bakeAnkiLabels(bytes, "image/png", labels, w => warnings.push(w));
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(labelled.bytes)]));
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = ctx.getImageData(0, 0, 200, 100).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i+1] < 100 && pixels[i+2] < 100) red++;
      const original = window.createImageBitmap;
      window.createImageBitmap = undefined;
      let fallback;
      try { fallback = await bakeAnkiLabels(bytes, "image/png", labels, w => warnings.push(w)); } finally { window.createImageBitmap = original; }
      return { unchanged: plain.bytes === bytes, red, warnings, fallback: JSON.stringify(fallback.bytes) === JSON.stringify(bytes) };
    });
    assert.equal(result.unchanged, true);
    assert.ok(result.red > 50);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.fallback, true);
  } finally { await page.close(); }
});

test("a partial failure reports saved modules without replaying their writes", async () => {
  const page = await open(2);
  try {
    const result = await page.evaluate(async session => {
      const plan = prepareAnkiImport(session.package, defaultSelection(session.package.decks));
      plan.modules[0].name = "Partial A"; plan.modules[1].name = "Partial B";
      let error = "";
      try { await importAnki(session, plan, () => {}); } catch (e) { error = String(e); }
      return { error, modules: await call("modules") };
    }, session);
    assert.match(result.error, /Saved modules: Partial A/);
    assert.ok(result.modules.some(m => m.name === "Partial A"));
    assert.ok(!result.modules.some(m => m.name === "Partial B"));
  } finally { await page.close(); }
});
