import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { browserHarness } from "./support/browser.mjs";

const { createServer } = browserHarness(import.meta.url);

test("outline setting persists, updates block titles, and navigates without adding rail entries", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = `http://localhost:${server.httpServer.address().port}/tests/browser/contents.html?short&blocks`;
    const block = title => `<details><summary>${title}</summary><div data-type="detailsContent"><p>Hidden body</p></div></details>`;
    const content = `<h1>Root</h1><h2>Topic</h2>${"<p>Some notes for scrolling.</p>".repeat(30)}${block("x^2")}${block("")}<h1>Other</h1>${block("Other block")}`;
    const load = async () => {
      await page.goto(url);
      await page.waitForFunction(() => !!window.editor);
      await page.evaluate(content => editor.commands.setContent(content), content);
      await page.locator('.toc-dash[aria-label="Topic"]').waitFor();
    };
    const popup = page.locator(".toc-popup");
    const open = async (name = "Root") => {
      await page.mouse.move(0, 0);
      await page.locator(`.toc-dash[aria-label="${name}"]`).hover();
      await popup.waitFor();
    };
    const waitRows = expected => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll(".toc-popup .toc-item")].map(el => el.getAttribute("aria-label"))) === JSON.stringify(expected), expected);
    await load();
    const setting = page.getByRole("switch", { name: /Foldable blocks in the outline/ });
    assert.equal(await setting.isChecked(), false);
    await open();
    await waitRows(["Root", "Topic"]);
    await setting.click();
    await open();
    await waitRows(["Root", "Topic", "x^2", "Untitled block"]);
    assert.deepEqual(await page.locator(".toc-dash").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))), ["Root", "Topic", "Other"]);
    // Same text, different node type: the outline must start rendering math.
    await page.evaluate(() => {
      let pos;
      editor.state.doc.forEach((node, offset) => { if (node.type.name === "details" && pos === undefined) pos = offset; });
      editor.commands.insertContentAt({ from: pos + 2, to: pos + 5 }, { type: "inlineMath", content: [{ type: "text", text: "x^2" }] });
    });
    await open();
    await popup.locator(".katex").waitFor();
    assert.equal(await popup.locator(".katex annotation").textContent(), "x^2");
    await popup.getByRole("button", { name: "x^2", exact: true }).click();
    await page.waitForFunction(() => {
      const top = document.querySelector(".foldable-block").getBoundingClientRect().top;
      return top >= 64 && top < 200;
    });
    assert.equal(await popup.count(), 0);
    // Closed blocks are navigable; folding the containing section hides them.
    await page.evaluate(() => editor.commands.toggleFold(store.state.find(item => item.textContent === "Topic").pos));
    await open();
    await waitRows(["Root", "Topic"]);
    await page.evaluate(() => {
      editor.commands.setFolds([]);
      editor.commands.showSection(store.state.find(item => item.textContent === "Other").pos);
    });
    await open("Other");
    await waitRows(["Other", "Other block"]);
    // Reload after the store's debounced save, using the real settings control.
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("app-state"))?.foldableBlocksInOutline === true);
    await load();
    assert.equal(await setting.isChecked(), true);
    await open();
    await waitRows(["Root", "Topic", "x^2", "Untitled block"]);
    await setting.click();
    await open();
    await waitRows(["Root", "Topic"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
