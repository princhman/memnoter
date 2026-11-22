import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as Y from "yjs";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const { createServer } = browserHarness(import.meta.url);
const cloze = "The capital of France is {{Paris}}.";

test("cloze clipboard through the desktop editor", async t => {
  execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], {
    cwd: workspace, env: { ...process.env, CARGO_BUILD_JOBS: "4" }, stdio: "pipe",
  });
  const child = spawn(`${workspace}/target/debug/examples/command-harness`, [], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(child, "exit");
  const pending = [];
  createInterface({ input: child.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  async function call(command, args = {}) {
    const response = await new Promise(resolve => {
      pending.push(resolve);
      child.stdin.write(JSON.stringify({ command, args }) + "\n");
    });
    if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
    return response.value;
  }

  let server, browser;
  try {
    const seedNote = async (moduleId, paragraphs) => {
      const doc = new Y.Doc();
      const root = doc.getXmlFragment("default");
      for (const { content, attrs = {} } of paragraphs) {
        const paragraph = new Y.XmlElement("paragraph");
        root.push([paragraph]);
        for (const [name, value] of Object.entries(attrs)) paragraph.setAttribute(name, value);
        const text = new Y.XmlText();
        paragraph.push([text]);
        text.insert(0, content);
      }
      await call("add_update", { moduleId, bytes: Array.from(Y.encodeStateAsUpdate(doc)) });
      doc.destroy();
    };
    const lastReviewAt = Date.now() - 86_400_000;
    const reviewed = {
      dueAt: lastReviewAt + 7 * 86_400_000, stability: 7.25, stabilityFast: 0.2, difficulty: 4.5,
      scheduledDays: 7, learningStep: 0, state: 2, scheduleStatus: "review", lastReviewAt, reps: 1, lapses: 0,
    };
    // Pass index: false for cards the open editor has already indexed.
    const review = async (moduleId, ...ids) => {
      const index = typeof ids.at(-1) === "object" ? ids.pop().index : true;
      if (index) await call("sync_cards", { moduleId, cards: ids.map(id => ({ id, kind: "cloze", front: [], back: [] })) });
      for (const cardId of ids) {
        await call("review_card", {
          cardId, expectedReps: 0, card: reviewed,
          log: {
            dueAt: lastReviewAt, stability: 0, stabilityFast: 0, difficulty: 0, scheduledDays: 0, learningStep: 0,
            state: 0, scheduleStatus: "new", lastReviewAt: null, rating: 3, reviewTime: lastReviewAt, fsrsModel: "6",
          },
        });
      }
    };

    server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
    await server.listen();
    browser = await chromium.launch();
    const origin = `http://localhost:${server.httpServer.address().port}`;
    const open = async (subtest, moduleId, proof) => {
      const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, permissions: ["clipboard-read", "clipboard-write"] });
      subtest.after(async () => {
        await page.close();
        if (proof && process.env.PROOF_DIR) {
          await rename(await page.video().path(), join(process.env.PROOF_DIR, `${proof}.webm`));
        }
      });
      await page.route("https://api.github.com/repos/princhman/memnoter/releases/latest", route => route.fulfill({ status: 404, json: {} }));
      await page.exposeFunction("rustCall", call);
      await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: (command, args) => command.startsWith("plugin:") ? 1 : window.rustCall(command, args) } });`);
      await page.goto(`${origin}/${moduleId}`);
      page.setDefaultTimeout(10_000);
      return page;
    };
    const dueCards = moduleId => call("due_cards", { moduleId, now: Date.now() + 30 * 86_400_000 });
    const waitForCards = async (editor, moduleId, matches) => {
      const deadline = Date.now() + 10_000;
      do {
        const cards = await call("card_schedules", { moduleId });
        if (matches(cards)) return;
        await delay(75);
      } while (Date.now() < deadline);
      assert.fail(`Unexpected schedules: ${JSON.stringify(await call("card_schedules", { moduleId }))}\nNote: ${await editor.textContent()}\n${await editor.page().locator("[data-sonner-toaster]").allTextContents()}`);
    };

    const pause = async page => { if (process.env.PROOF_DIR) await page.waitForTimeout(1050); };
    const select = async (editor, text, selected = text, offset = text.indexOf(selected)) => {
      await editor.locator("p").filter({ hasText: text }).first().waitFor();
      await editor.evaluate((el, { text, selected, offset }) => {
        const tiptap = el.editor;
        tiptap.state.doc.descendants((node, pos) => {
          if (node.isTextblock && node.textContent === text) {
            const from = pos + 1 + offset;
            tiptap.view.focus();
            tiptap.commands.setTextSelection({ from, to: from + selected.length });
            return false;
          }
        });
      }, { text, selected, offset });
    };
    const paragraphWithClozes = (content, blockId, ...answers) => ({
      content,
      attrs: { cardId: blockId, clozeIds: answers.map((answer, index) => ({
        id: `c${index + 1}`, from: content.indexOf(answer), to: content.indexOf(answer) + answer.length, answer,
      })) },
    });
    const note = async (name, blocks, ids) => {
      const moduleId = await call("create_module", { name });
      await seedNote(moduleId, blocks.map(block => typeof block === "string" ? { content: block } : block));
      if (ids.length) await review(moduleId, ...ids);
      return moduleId;
    };
    const openEditor = async (subtest, name, blocks, ids, proof) => {
      const source = await note(name, blocks, ids);
      const page = await open(subtest, source, proof);
      return { source, page, editor: page.locator(".tiptap[contenteditable=true]") };
    };
    const switchNote = async (page, name, moduleId) => {
      await page.getByText(name, { exact: true }).click();
      await page.waitForURL(`${origin}/${moduleId}`);
    };

    const pasteBelow = async (editor, anchor) => {
      await select(editor, anchor, "", anchor.length);
      await editor.page().keyboard.press("Enter");
      await pause(editor.page());
      await editor.page().keyboard.press("Control+v");
    };

    await t.test("pasting in another note creates a new card and spends the claim", async subtest => {
      const id = "cross-note:c1";
      const destination = await note("Other note", ["European capitals"], []);
      const { source, page, editor } = await openEditor(
        subtest, "Original note", [paragraphWithClozes(cloze, "cross-note", "Paris"), "Practice here"], [id], "cross-note-new-card",
      );
      if (process.env.PROOF_DIR) {
        await editor.locator('p[data-card-id="cross-note"] .card-info').hover();
        await page.getByRole("tooltip").getByText("Last reviewed", { exact: false }).waitFor();
        await pause(page);
      }
      await select(editor, cloze);
      await pause(page);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await pause(page);

      await switchNote(page, "Other note", destination);
      await pasteBelow(editor, "European capitals");
      await waitForCards(editor, destination, cards => cards.length === 1);
      const [fresh] = await dueCards(destination);
      assert.notEqual(fresh.id, id);
      assert.equal(fresh.reps, 0);
      assert.equal(fresh.lastReviewAt, null);
      await pause(page);
      await editor.locator("p").filter({ hasText: "Paris" }).locator(".card-info").hover();
      await page.getByRole("tooltip").getByText("Never reviewed", { exact: true }).waitFor();
      await pause(page);

      await switchNote(page, "Original note", source);
      await pasteBelow(editor, "Practice here");
      await waitForCards(editor, source, cards => cards.length === 1);
      const [repeated] = await dueCards(source);
      assert.notEqual(repeated.id, id);
      assert.equal(repeated.reps, 0);
    });

    await t.test("a same-note cut moves the whole paragraph with its schedule", async subtest => {
      const anchor = "European capitals";
      const id = "same-note:c1";
      const { source, page, editor } = await openEditor(
        subtest, "Move within a note", [paragraphWithClozes(cloze, "same-note", "Paris"), anchor, "More practice"], [id], "same-note",
      );
      await select(editor, cloze);
      await pause(page);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await pause(page);
      await pasteBelow(editor, anchor);
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id && cards[0].state === 2);
      const [moved] = await dueCards(source);
      for (const [key, value] of Object.entries(reviewed)) assert.equal(moved[key], value, key);
      const movedBlock = editor.locator('p[data-card-id="same-note"]');
      assert.equal(await movedBlock.evaluate(node => node.previousElementSibling?.textContent), anchor);
      await pause(page);
      await movedBlock.locator(".card-info").hover();
      await editor.locator(".card-info-reviewed").filter({ hasText: "Last reviewed" }).waitFor();
      await pause(page);
      // Joining the moved card into ordinary text keeps its identity.
      await select(editor, cloze, "");
      await page.keyboard.press("Backspace");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id && cards[0].state === 2);
      await movedBlock.filter({ hasText: /European capitals.*Paris/ }).waitFor();
      await pasteBelow(editor, "More practice");
      await waitForCards(editor, source, cards => cards.length === 2);
      const fresh = (await dueCards(source)).find(card => card.id !== id);
      assert.equal(fresh.reps, 0);
      assert.equal(fresh.lastReviewAt, null);
    });

    await t.test("a clipped cloze pastes as new while the remaining cloze keeps its history", async subtest => {
      const sentence = "{{Paris}} is in {{France}}";
      const paris = "pair:c1";
      const france = "pair:c2";
      const { source, page, editor } = await openEditor(
        subtest, "Clipped cloze", [paragraphWithClozes(sentence, "pair", "Paris", "France")], [paris, france],
      );
      await select(editor, sentence, "{{Paris}}");
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === france && cards[0].state === 2);
      await page.keyboard.press("Control+v");
      await waitForCards(editor, source, cards => cards.length === 2);
      const cards = await dueCards(source);
      const remaining = cards.find(card => card.id === france);
      const pasted = cards.find(card => card.id !== france);
      assert.equal(remaining.reps, 1);
      assert.notEqual(pasted.id, paris);
      assert.equal(pasted.reps, 0);
    });

    for (const [name, offset] of [["between clozes", 12], ["inside a cloze", 20]]) {
      await t.test(`pasting ${name} inserts a separate paragraph and preserves all schedules`, async subtest => {
        const target = "{{London}} and {{Berlin}}";
        const sourceId = `moved-${offset}`;
        const targetId = `capitals-${offset}`;
        const ids = [`${targetId}:c1`, `${targetId}:c2`, `${sourceId}:c1`];
        const { source, page, editor } = await openEditor(
          subtest, `Paste ${name}`, [
            paragraphWithClozes(cloze, sourceId, "Paris"),
            paragraphWithClozes(target, targetId, "London", "Berlin"),
          ], ids, name === "inside a cloze" ? "inside-card-paragraph" : undefined,
        );
        await select(editor, cloze);
        await pause(page);
        await page.keyboard.press("Control+x");
        await waitForCards(editor, source, cards => cards.length === 2 && cards.every(card => card.id !== ids[2]));
        await pause(page);
        await select(editor, target, "", offset);
        await pause(page);
        await page.keyboard.press("Control+v");
        await waitForCards(editor, source, cards => cards.length === 3);
        const cards = await dueCards(source);
        assert.deepEqual(cards.map(card => card.id).sort(), ids);
        for (const card of cards) {
          for (const [key, value] of Object.entries(reviewed)) assert.equal(card[key], value, `${card.id} ${key}`);
        }
        const targetBlock = editor.locator(`p[data-card-id="${targetId}"]`);
        assert.deepEqual(await editor.evaluate(el => {
          const paragraphs = [];
          el.editor.state.doc.forEach(block => { if (block.type.name === "paragraph") paragraphs.push(block.textContent); });
          return paragraphs;
        }), ["", target, cloze]);
        await pause(page);
        if (process.env.PROOF_DIR && name === "inside a cloze") {
          await targetBlock.locator(".card-info").hover();
          const details = targetBlock.getByRole("dialog");
          await details.getByText("London", { exact: true }).waitFor();
          await details.getByText("Berlin", { exact: true }).waitFor();
          assert.equal(await details.getByText("Last reviewed", { exact: false }).count(), 2);
          await pause(page);
          await page.mouse.move(900, 500);
          await details.waitFor({ state: "hidden" });
          await editor.locator(`p[data-card-id="${sourceId}"] .card-info`).hover();
          await page.getByRole("tooltip").getByText("Last reviewed", { exact: false }).waitFor();
          await pause(page);
        }
      });
    }

    await t.test("pasting far from the original cloze note keeps intervening text out of review", async subtest => {
      const id = "partial-note:c1";
      const sentence = "{{Paris}} is the capital.";
      const context = "European capitals";
      const gap = "Unrelated material";
      const end = "Separate topic";
      const source = await call("create_module", { name: "Partial cloze note" });
      const paragraph = paragraphWithClozes(sentence, "partial-note", "Paris");
      await seedNote(source, [
        { content: context, attrs: { clozeNote: "original-note" } },
        { ...paragraph, attrs: { ...paragraph.attrs, clozeNote: "original-note" } },
        { content: gap },
        { content: end },
      ]);
      await review(source, id);
      const page = await open(subtest, source);
      const editor = page.locator(".tiptap[contenteditable=true]");
      await select(editor, sentence);
      await pause(page);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await pause(page);
      await select(editor, end, "");
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await pause(page);
      await page.keyboard.press("Control+v");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id);
      const [card] = await dueCards(source);
      assert.equal(card.reps, 1);
      assert.doesNotMatch(JSON.stringify(card.front), /Unrelated material|Separate topic|European capitals/);
      await pause(page);
      await editor.locator('p').filter({ hasText: "Paris" }).locator(".card-info").hover();
      await editor.locator(".card-info-reviewed").filter({ hasText: "Last reviewed" }).waitFor();
      await pause(page);
    });

    await t.test("paste as plain text spends the cut claim", async subtest => {
      const id = "plain:c1";
      const { source, page, editor } = await openEditor(
        subtest, "Plain paste", [paragraphWithClozes(cloze, "plain", "Paris"), "First", "Second"], [id],
      );
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await select(editor, "First");
      await page.keyboard.press("Control+Shift+v");
      await waitForCards(editor, source, cards => cards.length === 1);
      await select(editor, "Second");
      await page.keyboard.press("Control+v");
      await waitForCards(editor, source, cards => cards.length === 2);
      const cards = await dueCards(source);
      assert.ok(cards.every(card => card.id !== id && card.reps === 0));
    });

    await t.test("a reload drops the cut claim while the cut remains deleted", async subtest => {
      const id = "reload:c1";
      const source = await call("create_module", { name: "Session lifetime" });
      await seedNote(source, [paragraphWithClozes(cloze, "reload", "Paris"), { content: "Destination" }]);
      await review(source, id);
      const page = await open(subtest, source);
      const editor = page.locator(".tiptap[contenteditable=true]");
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await page.reload();
      await waitForCards(editor, source, cards => cards.length === 0);
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 1);
      const [pasted] = await dueCards(source);
      assert.notEqual(pasted.id, id);
      assert.equal(pasted.reps, 0);
    });

    for (const shortcut of ["Control+v", "Control+Shift+v"]) {
      await t.test(`a copied cloze cannot reclaim a retired identity with ${shortcut}`, async subtest => {
        const blockId = shortcut === "Control+v" ? "rich-copy" : "plain-copy";
        const id = `${blockId}:c1`;
        const { source, page, editor } = await openEditor(
          subtest, shortcut, [paragraphWithClozes(cloze, blockId, "Paris")], [id],
        );
        await select(editor, cloze, "{{Paris}}");
        await page.keyboard.press("Control+c");
        await page.keyboard.press("Backspace");
        await waitForCards(editor, source, cards => cards.length === 0);
        await page.keyboard.press(shortcut);
        await waitForCards(editor, source, cards => cards.length === 1);
        const [copied] = await dueCards(source);
        assert.notEqual(copied.id, id);
        assert.equal(copied.reps, 0);
      });
    }

    await t.test("a spent cut still pastes beside a card instead of splitting it", async subtest => {
      const id = "spent:c1";
      const target = "{{London}} and {{Berlin}}";
      const ids = ["spent-target:c1", "spent-target:c2"];
      const { source, page, editor } = await openEditor(
        subtest, "Spent cut", [paragraphWithClozes(cloze, "spent", "Paris"), "Destination", paragraphWithClozes(target, "spent-target", "London", "Berlin")], [id, ...ids],
      );
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 2);
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 3 && cards.some(card => card.id === id));
      await select(editor, target, "", 20);
      await page.keyboard.press("Control+v");
      await waitForCards(editor, source, cards => cards.length === 4);
      const cards = await dueCards(source);
      for (const kept of [id, ...ids]) assert.equal(cards.find(card => card.id === kept)?.reps, 1, kept);
      assert.equal(cards.filter(card => card.reps === 0).length, 1);
    });

    await t.test("pasting into code does not spend the cut claim", async subtest => {
      const id = "code:c1";
      const source = await call("create_module", { name: "Paste into code" });
      const doc = new Y.Doc();
      const block = new Y.XmlElement("codeBlock");
      doc.getXmlFragment("default").push([block]);
      const text = new Y.XmlText();
      block.push([text]);
      text.insert(0, "E = mc^2");
      await call("add_update", { moduleId: source, bytes: Array.from(Y.encodeStateAsUpdate(doc)) });
      doc.destroy();
      await seedNote(source, [paragraphWithClozes(cloze, "code", "Paris"), { content: "Destination" }]);
      await review(source, id);
      const page = await open(subtest, source);
      const editor = page.locator(".tiptap[contenteditable=true]");
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await editor.evaluate(el => {
        const tiptap = el.editor;
        tiptap.state.doc.descendants((node, pos) => {
          if (node.type.name === "codeBlock") {
            tiptap.view.focus();
            tiptap.commands.setTextSelection(pos + 2);
            return false;
          }
        });
      });
      await page.keyboard.press("Control+v");
      await editor.locator("pre").filter({ hasText: "Paris" }).waitFor();
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id);
      const [card] = await dueCards(source);
      assert.equal(card.reps, 1);
    });

    await t.test("undoing a cut and deleting the restored text still lets the cut paste", async subtest => {
      const id = "undo-delete:c1";
      const { source, page, editor } = await openEditor(
        subtest, "Undo then delete", [paragraphWithClozes(cloze, "undo-delete", "Paris"), "Destination"], [id],
      );
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await page.keyboard.press("Control+z");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id);
      await select(editor, cloze);
      await page.keyboard.press("Backspace");
      await waitForCards(editor, source, cards => cards.length === 0);
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 1 && cards[0].id === id);
      const [card] = await dueCards(source);
      assert.equal(card.reps, 1);
    });

    await t.test("a cloze added to the emptied block keeps its schedule and the cut pastes as new", async subtest => {
      const id = "refilled:c1";
      const { source, page, editor } = await openEditor(
        subtest, "Refilled block", [paragraphWithClozes(cloze, "refilled", "Paris"), "Destination"], [id],
      );
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await page.keyboard.type("Rome is in {{Italy}}");
      await waitForCards(editor, source, cards => cards.length === 1);
      const [{ id: rome }] = await call("card_schedules", { moduleId: source });
      assert.match(rome, /^refilled:/);
      await review(source, rome, { index: false });
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 2);
      const cards = await dueCards(source);
      assert.equal(cards.find(card => card.id === rome)?.reps, 1);
      const pasted = cards.find(card => card.id !== rome);
      assert.notEqual(pasted.id, id);
      assert.equal(pasted.reps, 0);
    });

    await t.test("pasting inside a grouped card opener lands before it", async subtest => {
      const id = "beside-group:c1";
      const opener = "Question ::block";
      const { source, page, editor } = await openEditor(
        subtest, "Grouped card", [paragraphWithClozes(cloze, "beside-group", "Paris"), opener, "Answer", "::end"], [id],
      );
      await waitForCards(editor, source, cards => cards.length === 2);
      const group = (await call("card_schedules", { moduleId: source })).find(card => card.id !== id).id;
      await review(source, group, { index: false });
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 1);
      await select(editor, opener, "", opener.indexOf("l"));
      await page.keyboard.press("Control+v");
      await waitForCards(editor, source, cards => cards.length === 2 && cards.some(card => card.id === id));
      const cards = await dueCards(source);
      for (const kept of [id, group]) assert.equal(cards.find(card => card.id === kept)?.reps, 1, kept);
      assert.deepEqual(await editor.evaluate(el => {
        const blocks = [];
        el.editor.state.doc.forEach(block => blocks.push(block.textContent));
        return blocks;
      }), ["", cloze, opener, "Answer", "::end"]);
    });

    await t.test("a clipboard whose text no longer matches the cut pastes as new", async subtest => {
      const id = "rewritten:c1";
      const { source, page, editor } = await openEditor(
        subtest, "Rewritten clipboard", [paragraphWithClozes(cloze, "rewritten", "Paris"), "Destination"], [id],
      );
      await select(editor, cloze);
      await page.keyboard.press("Control+x");
      await waitForCards(editor, source, cards => cards.length === 0);
      await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        const html = (await (await item.getType("text/html")).text()).replaceAll("Paris", "Tokyo");
        const text = (await (await item.getType("text/plain")).text()).replaceAll("Paris", "Tokyo");
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
      });
      await pasteBelow(editor, "Destination");
      await waitForCards(editor, source, cards => cards.length === 1);
      const [pasted] = await dueCards(source);
      assert.notEqual(pasted.id, id);
      assert.equal(pasted.reps, 0);
    });
  } finally {
    await browser?.close();
    await server?.close();
    child.stdin.end();
    await exited;
  }
});
