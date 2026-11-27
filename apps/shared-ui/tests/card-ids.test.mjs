import { browserHarness } from "./support/browser.mjs";
// Card text without an id gets one when its note loads, either opened or
// checked in the background. That id must be saved into the note, or every
// launch makes a new card and the old one loses its review history. Runs the
// app in WebKit against a fake Tauri backend that keeps saves in memory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const { createServer, webkit } = browserHarness(import.meta.url);

const root = fileURLToPath(new URL("..", import.meta.url));
let server, browser, url;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  browser = await webkit.launch();
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// A note with one basic card, written before cards had ids.
function noteWithoutIds() {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "Question :: answer");
  paragraph.insert(0, [text]);
  doc.getXmlFragment("default").insert(0, [paragraph]);
  return [{ id: 1, bytes: Array.from(Y.encodeStateAsUpdate(doc)) }];
}

// One app launch at `route`: returns what it saved and the cards it synced.
async function launch(route, updates) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.addInitScript((updates) => {
    let callbacks = 0;
    window.__saved = [];
    window.__synced = [];
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return callbacks;
        if (command === "modules") return [{ id: "m1", name: "Demo" }];
        if (command === "get_content") return { state: [], updates, files: [] };
        if (command === "unindexed_card_modules") {
          return window.__synced.length ? [] : [{ id: "m1", name: "Demo" }];
        }
        if (command === "add_update") {
          window.__saved.push(args.bytes);
          return { id: 100 + window.__saved.length, bytes: args.bytes };
        }
        if (command === "sync_cards") {
          window.__synced.push(args.cards.map((card) => card.id));
          return [];
        }
        if (["due_counts", "due_cards", "search_notes", "unindexed_modules"].includes(command)) {
          return [];
        }
        return null;
      } } });

  }, updates);
  await page.goto(`${url}${route}`);
  await page.waitForFunction(() => window.__synced.length > 0);
  // Let any save that follows the sync land.
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({
    saved: window.__saved,
    synced: window.__synced.at(-1),
  }));
  await page.close();
  return result;
}

function savedCardId(updates) {
  const doc = new Y.Doc();
  for (const { bytes } of updates) Y.applyUpdate(doc, Uint8Array.from(bytes));
  return doc.getXmlFragment("default").get(0).getAttribute("cardId");
}

for (const [name, route] of [
  ["opening the note", "/m1"],
  ["the background check", "/"],
]) {
  test(`${name} saves the id it gives a card`, async () => {
    const updates = noteWithoutIds();
    const first = await launch(route, updates);
    assert.equal(first.synced.length, 1);
    for (const bytes of first.saved) updates.push({ id: updates.length + 1, bytes });
    assert.equal(savedCardId(updates), first.synced[0]);

    const second = await launch(route, updates);
    assert.deepEqual(second.synced, first.synced);
    assert.equal(second.saved.length, 0);
  });
}

let harnessBuilt = false;

async function withCore(run, invoke = (command, args, call) => call(command, args), { mac = false } = {}) {
  const workspace = fileURLToPath(new URL("../../..", import.meta.url));
  if (!harnessBuilt) execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], {
    cwd: workspace, env: { ...process.env, CARGO_BUILD_JOBS: "4" }, stdio: "pipe",
  });
  harnessBuilt = true;
  const child = spawn(join(workspace, "target/debug/examples/command-harness"), [], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(child, "exit");
  const pending = [];
  createInterface({ input: child.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  const call = async (command, args = {}) => {
    const response = await new Promise(resolve => {
      pending.push(resolve);
      child.stdin.write(JSON.stringify({ command, args }) + "\n");
    });
    if (response.error) throw new Error(response.error.message ?? response.error);
    return response.value;
  };

  const page = await browser.newPage();
  let db;
  try {
    const source = await call("create_module", { name: "Geography" });
    const destination = await call("create_module", { name: "Travel" });
    db = new DatabaseSync(join(tmpdir(), `memnoter-harness-${child.pid}`, "main.db"), { readOnly: true });
    const log = db.prepare("select rating, review_time from review_log where card_id = ?");
    await page.exposeFunction("rustCall", (command, args) => {
      if (command.startsWith("plugin:") || command === "set_editor_history") return 1;
      return invoke(command, args, call);
    });
    await page.addInitScript(mac => {
      if (mac) {
        Object.defineProperty(navigator, "platform", { value: "MacIntel" });
        Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
      }
      window.installTestBridge({ tauri: { invoke: (command, args) => window.rustCall(command, args) } });
    }, mac);
    const editor = page.locator('.tiptap[contenteditable="true"]');
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const schedules = async (moduleId, count) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const cards = await call("card_schedules", { moduleId });
        if (cards.length === count) return cards;
        await delay(50);
      }
      assert.fail(`Expected ${count} synced cards in ${moduleId}`);
    };

    const open = async moduleId => {
      await page.goto(`${url}/${moduleId}`);
      await editor.click();
    };
    const travel = async () => {
      await page.getByRole("link", { name: "Travel", exact: true }).click();
      await editor.click();
    };
    const grade = card => page.evaluate(async stored => {
      const { getScheduler, scheduleReview } = await import("/src/lib/fsrs.ts");
      const { card, log } = scheduleReview(await getScheduler(), stored, 4, Date.now());
      await window.rustCall("review_card", { cardId: stored.id, expectedReps: 0, card, log });
    }, card);
    const reviewAll = async (moduleId, count) => {
      await schedules(moduleId, count);
      const cards = await call("due_cards", { moduleId, now: Number.MAX_SAFE_INTEGER });
      for (const card of cards) await grade(card);
      return schedules(moduleId, count);
    };
    const select = (from, to) => editor.evaluate((el, range) => el.editor.commands.setTextSelection(range), { from, to });
    const key = key => page.keyboard.press(key);
    await run({ page, editor, mod, source, destination, call, schedules, log, open, travel, grade, reviewAll, select, key });
  } finally {
    db?.close();
    await page.close();
    child.stdin.end();
    await exit;
  }
}

test("the first cut paste keeps cloze history across and within notes, while copies are new", () =>
  withCore(async ({ page, editor, mod, source, destination, call, schedules, log, grade, open, travel }) => {
    await open(source);
    await page.keyboard.type("{{Paris}} and {{France}}");
    await schedules(source, 2);
    const cards = await call("due_cards", { moduleId: source, now: Number.MAX_SAFE_INTEGER });
    const paris = cards.find(({ back }) => back.some(part => part.type === "cloze" && part.children.map(child => child.text).join("") === "Paris"));
    assert.ok(paris, JSON.stringify({ cards, text: await editor.textContent() }));
    const france = cards.find(card => card.id !== paris.id);
    await grade(paris);
    const initial = (await schedules(source, 2)).find(card => card.id === paris.id);
    const review = log.get(paris.id);
    assert.equal(review.rating, 4);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+x`);
    assert.equal(await editor.evaluate(el => el.editor.getText()), " and {{France}}");
    const [remaining] = await schedules(source, 1);
    assert.equal(remaining.id, france.id);

    await travel();
    await page.keyboard.press(`${mod}+v`);
    const [moved] = await schedules(destination, 1);
    assert.notEqual(moved.id, paris.id);
    assert.deepEqual(moved, { ...initial, id: moved.id });
    assert.deepEqual(log.get(moved.id), review);
    assert.equal(log.get(paris.id), undefined);

    // End doesn't move to the line end on macOS; place the caret explicitly.
    await editor.evaluate(el => el.editor.commands.focus("end"));
    await page.waitForFunction(() => window.getSelection()?.isCollapsed);
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const repeated = await schedules(destination, 2);
    assert.deepEqual(repeated.find(card => card.id === moved.id), moved);
    assert.equal(repeated.find(card => card.id !== moved.id).lastReviewAt, null);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+c`);
    // End doesn't move to the line end on macOS; place the caret explicitly.
    await editor.evaluate(el => el.editor.commands.focus("end"));
    await page.waitForFunction(() => window.getSelection()?.isCollapsed);
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const copied = await schedules(destination, 3);
    assert.deepEqual(copied.filter(card => card.lastReviewAt !== null), [moved]);

    await editor.evaluate(el => el.editor.commands.setTextSelection({ from: 1, to: 10 }));
    await page.waitForFunction(() => window.getSelection()?.toString().includes("{{Paris}}"));
    await page.keyboard.press(`${mod}+x`);
    await schedules(destination, 2);
    // End doesn't move to the line end on macOS; place the caret explicitly.
    await editor.evaluate(el => el.editor.commands.focus("end"));
    await page.waitForFunction(() => window.getSelection()?.isCollapsed);
    await page.keyboard.type(" and ");
    await page.keyboard.press(`${mod}+v`);
    const repasted = await schedules(destination, 3);
    const movedAgain = repasted.find(card => card.lastReviewAt !== null);
    assert.ok(movedAgain);
    assert.notEqual(movedAgain.id, moved.id);
    assert.deepEqual(movedAgain, { ...initial, id: movedAgain.id });
    assert.deepEqual(log.get(movedAgain.id), review);
    assert.deepEqual(repasted.filter(card => card.id !== movedAgain.id), copied.filter(card => card.id !== moved.id));
  }));


test("a spent cut cannot recover the history of its deleted first paste", () =>
  withCore(async ({ page, editor, source, destination, schedules, reviewAll, open, travel, select, key, mod }) => {
    await open(source);
    await page.keyboard.type("{{Paris}}");
    await reviewAll(source, 1);
    await select(1, 10);
    await key(`${mod}+x`);
    await schedules(source, 0);
    await travel();
    await page.keyboard.type("Capital: ");
    await key(`${mod}+v`);
    const [first] = await schedules(destination, 1);
    assert.ok(first.lastReviewAt);
    await select(10, 19);
    await key("Backspace");
    assert.equal(await editor.evaluate(el => el.editor.getText()), "Capital: ");
    await schedules(destination, 0);
    await key(`${mod}+v`);
    const [second] = await schedules(destination, 1);
    assert.notEqual(second.id, first.id);
    assert.equal(second.lastReviewAt, null);
  }));

for (const acrossNotes of [false, true]) {
  test(`cutting formula source keeps the cloze and its history ${acrossNotes ? "across notes" : "in its original block"}`, () =>
    withCore(async ({ editor, source, destination, schedules, reviewAll, log, open, travel, select, key, mod }) => {
      await open(source);
      await editor.evaluate(el => el.editor.commands.setContent({
        type: "doc",
        content: [{ type: "mathBlock", attrs: { cloze: true }, content: [{ type: "text", text: "a + b" }] }],
      }));
      const [before] = await reviewAll(source, 1);
      const review = log.get(before.id);
      await select(1, 6);
      await key(`${mod}+x`);
      await schedules(source, 0);
      if (acrossNotes) await travel();
      await key(`${mod}+v`);
      const [after] = await schedules(acrossNotes ? destination : source, 1);
      assert.equal(await editor.evaluate(el => el.editor.state.doc.firstChild.type.name), "mathBlock");
      assert.notEqual(after.id, before.id);
      assert.deepEqual(after, { ...before, id: after.id });
      assert.deepEqual(log.get(after.id), review);
    }));
}

test("cutting and pasting multiple table cells moves each cloze's history", () =>
  withCore(async ({ editor, source, schedules, reviewAll, log, open, key, mod }) => {
    await open(source);
    await editor.evaluate(el => {
      const cell = text => ({
        type: "tableCell", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
      });
      el.editor.commands.setContent({
        type: "doc",
        content: [{ type: "table", content: [{ type: "tableRow", content: [
          cell("{{Paris}}"), cell("{{Berlin}}"), cell(""), cell(""),
        ] }] }],
      });
    });
    const before = await reviewAll(source, 2);
    const history = cards => cards.map(({ id, ...schedule }) => ({ schedule, review: log.get(id) }))
      .sort((a, b) => a.schedule.lastReviewAt - b.schedule.lastReviewAt);
    const expected = history(before);
    const cellPositions = () => editor.evaluate(el => {
      const positions = [];
      el.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "tableCell") positions.push(pos);
      });
      return positions;
    });
    const selectCells = (anchorCell, headCell) => editor.evaluate((el, range) =>
      el.editor.commands.setCellSelection(range), { anchorCell, headCell });
    const [first, second] = await cellPositions();
    await selectCells(first, second);
    await key(`${mod}+x`);
    await schedules(source, 0);
    const [, , third, fourth] = await cellPositions();
    await selectCells(third, fourth);
    await key(`${mod}+v`);
    const after = await schedules(source, 2);
    const contents = await editor.evaluate(el => {
      const cells = [];
      el.editor.state.doc.descendants(node => {
        if (node.type.name === "tableCell") cells.push(node.textContent);
      });
      return cells;
    });
    assert.ok(after.every(card => !before.some(previous => previous.id === card.id)));
    const transferred = history(after);
    assert.ok(transferred.every(card => card.review), "each pasted cloze keeps a review log");
    assert.deepEqual(transferred, expected);
    assert.deepEqual(contents, ["", "", "{{Paris}}", "{{Berlin}}"]);
  }));

test("a successful save retry retires a cut card without another editor update", async () => {
  let failNextSave = false;
  let failed = false;
  let retried = false;
  await withCore(async ({ page, source, schedules, open, select, key, mod }) => {
    await open(source);
    await page.keyboard.type("{{Paris}}");
    await schedules(source, 1);
    await select(1, 10);
    failNextSave = true;
    await key(`${mod}+x`);
    await schedules(source, 0);
    assert.ok(failed && retried);
  }, async (command, args, call) => {
    if (command === "add_update" && failNextSave) {
      failNextSave = false;
      await delay(1100); // Let the card index start waiting for the failed write.
      failed = true;
      throw new Error("Transient test save failure");
    }
    const result = await call(command, args);
    if (command === "add_update" && failed) retried = true;
    return result;
  });
});

test("selective backup edits persist, undo, and keep an untouched card's review history", async () => {
  const original = ["Read chapter one.", "What is the capital of France? :: Paris", "Review again on Friday."];
  const edited = ["Read chapters one and two.", original[1], "Review again on Monday."];
  const name = "Geography";
  let file;
  await withCore(async ({ page, editor, source, call, schedules, log, grade, open }) => {
    file = { path: `geography - ${source}.md`, moduleId: source, noteName: name,
      markdown: edited.join("\n\n") + "\n", hash: "outside-edit" };
    const doc = new Y.Doc();
    const paragraphs = original.map(value => {
      const block = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, value);
      block.insert(0, [text]);
      return block;
    });
    doc.getXmlFragment("default").insert(0, paragraphs);
    await call("add_update", { moduleId: source, bytes: Array.from(Y.encodeStateAsUpdate(doc)) });
    doc.destroy();
    await open(source);

    const [card] = await call("due_cards", { moduleId: source, now: Number.MAX_SAFE_INTEGER })
      .then(async cards => {
        if (cards.length) return cards;
        await schedules(source, 1);
        return call("due_cards", { moduleId: source, now: Number.MAX_SAFE_INTEGER });
      });
    await grade(card);
    const [reviewed] = await schedules(source, 1);
    const history = log.all(card.id);
    assert.equal(history.length, 1);

    const pace = () => process.env.PROOF_DIR ? delay(850) : Promise.resolve();
    const theme = process.env.BACKUP_PROOF_THEME === "dark" ? "dark" : "light";
    if (process.env.PROOF_DIR) await page.emulateMedia({ colorScheme: theme });
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const check = page.getByRole("button", { name: "Check backup for edits", exact: true });
    await check.scrollIntoViewIfNeeded();
    await pace();
    await check.click();
    const dialog = page.getByRole("dialog", { name: "Backup edits" });
    await dialog.getByText(edited[0], { exact: true }).waitFor();
    await dialog.getByText(edited[2], { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("checkbox").count(), 2);
    await pace();
    await dialog.getByRole("button", { name: "Apply all", exact: true }).click();
    await pace();
    await dialog.getByRole("checkbox").nth(1).uncheck();
    await pace();

    if (process.env.PROOF_DIR) {
      await dialog.screenshot({ path: join(process.env.PROOF_DIR, `backup-edits-${theme}.png`) });
    }

    await dialog.getByRole("button", { name: "Apply selected changes", exact: true }).click();
    await editor.getByText(edited[0], { exact: true }).waitFor();
    assert.equal(await editor.getByText(original[2], { exact: true }).count(), 1);
    await pace();

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await editor.getByText(original[0], { exact: true }).waitFor();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await editor.getByText(edited[0], { exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const { saveQueue } = await import("/src/lib/saves.ts");
      return saveQueue.isIdle();
    });
    const persisted = await call("get_content", { moduleId: source });
    const saved = new Y.Doc();
    for (const bytes of [persisted.state, ...persisted.updates.map(update => update.bytes)]) {
      if (bytes.length) Y.applyUpdate(saved, Uint8Array.from(bytes));
    }
    const blocks = saved.getXmlFragment("default").toArray();
    assert.equal(blocks[0].get(0).toString(), edited[0]);
    assert.equal(blocks[1].getAttribute("cardId"), card.id);
    assert.equal(blocks[2].get(0).toString(), original[2]);
    assert.deepEqual((await schedules(source, 1))[0], reviewed);
    assert.deepEqual(log.all(card.id), history);
    saved.destroy();
  }, (command, args, call) => {
    if (command === "local_backup_settings") return { enabled: false, folder: "/Documents/Notes" };
    if (command === "local_backup_image_types") return {};
    if (command === "read_local_backup_edits") return [file];
    return call(command, args);
  }, { mac: true });
});

test("scheduled backup notices deduplicate file contents and Review applies an edit", async () => {
  const folder = await mkdtemp(join(await realpath(tmpdir()), "memnoter-backup-"));
  const backupFolder = join(folder, "Memnoter Backup");
  let scans = 0;
  try {
    await withCore(async ({ page, source, call, editor, open }) => {
      const original = "Review the maps on Friday.";
      const firstEdit = "Review the maps on Monday.";
      const secondEdit = "Review the maps on Tuesday.";
      const doc = new Y.Doc();
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, original);
      paragraph.insert(0, [text]);
      doc.getXmlFragment("default").insert(0, [paragraph]);
      await call("add_update", { moduleId: source, bytes: Array.from(Y.encodeStateAsUpdate(doc)) });
      doc.destroy();

      await page.clock.install();
      await page.emulateMedia({ colorScheme: "light" });
      const pace = () => process.env.PROOF_DIR ? delay(1050) : Promise.resolve();
      const scan = async (count, startup = false) => {
        if (!startup) await page.clock.fastForward(10 * 60 * 1000);
        for (let attempt = 0; scans < count && attempt < 100; attempt++) await delay(50);
        assert.equal(scans, count);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const notice = page.locator("[data-sonner-toast]").filter({ hasText: "Edits found in the backup: 1 note" });
      const dialog = page.getByRole("dialog", { name: "Backup edits" });
      await open(source);
      await scan(1, true);
      const filenames = await readdir(backupFolder);
      const path = join(backupFolder, filenames.find(name => name.startsWith("geography") && name.endsWith(".md")));
      const exported = await readFile(path, "utf8");
      assert.ok(exported.includes(original));

      await pace();
      await writeFile(path, exported.replace(original, firstEdit));
      await scan(2);
      await notice.waitFor();
      assert.equal(await dialog.count(), 0);
      assert.equal(await editor.evaluate(el => el === document.activeElement), true);
      await pace();
      if (process.env.PROOF_DIR) await page.screenshot({ path: join(process.env.PROOF_DIR, "backup-toast-light.png") });
      await notice.getByRole("button", { name: "Close toast" }).click();
      await notice.waitFor({ state: "hidden" });
      await scan(3);
      assert.equal(await notice.count(), 0);

      await page.reload();
      await scan(4, true);
      assert.equal(await notice.count(), 0);

      await writeFile(path, exported.replace(original, secondEdit));
      if (process.env.PROOF_DIR) await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await scan(5, true);
      await notice.waitFor();
      await pace();
      if (process.env.PROOF_DIR) await page.screenshot({ path: join(process.env.PROOF_DIR, "backup-toast-dark.png") });
      await notice.getByRole("button", { name: "Review", exact: true }).click();
      await dialog.getByText(secondEdit, { exact: true }).waitFor();
      await pace();
      await dialog.getByRole("checkbox", { name: "Apply change" }).check();
      await pace();
      await dialog.getByRole("button", { name: "Apply selected changes" }).click();
      await editor.getByText(secondEdit, { exact: true }).waitFor();
      await pace();
    }, async (command, args, call) => {
      if (command === "local_backup_settings") return { folder, enabled: true };
      if (command === "local_backup_image_types") return {};
      const result = await call(command, args);
      if (command === "read_local_backup_edits") scans++;
      return result;
    }, { mac: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
