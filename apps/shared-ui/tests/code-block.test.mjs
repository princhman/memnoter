import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const { createServer } = browserHarness(import.meta.url);

test("the desktop note creates, indents, highlights, copies and reloads code blocks", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(7000);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${(() => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        const updates = JSON.parse(localStorage.getItem("code-block-updates") || "[]");
        if (command === "modules") return [{ id: "code", name: "Code examples" }];
        if (command === "get_content") return { state: [], updates, files: [] };
        if (command === "add_update") {
          const saved = { id: updates.length + 1, bytes: args.bytes };
          localStorage.setItem("code-block-updates", JSON.stringify([...updates, saved]));
          return saved;
        }
        if (command === "plugin:window|is_fullscreen") return false;
        return [];
      } } });
    }).toString()})();`);
    await page.goto(`http://localhost:${server.httpServer.address().port}/code`, { waitUntil: "commit" });

    const editor = page.locator(".tiptap[contenteditable=true]");
    const language = page.getByRole("combobox", { name: "Code language" });
    const copy = page.getByRole("button", { name: "Copy code block" });
    const code = editor.locator("pre code");
    const settle = async () => {
      if (process.env.PROOF_DIR) await page.waitForTimeout(1150);
    };
    const type = input => page.keyboard.type(input, { delay: process.env.PROOF_DIR ? 80 : 0 });

    await editor.click();
    await settle();
    await type("```python");
    await settle();
    await page.keyboard.press("Enter");
    assert.equal(await language.inputValue(), "python");
    await settle();

    await type("if x:");
    await page.keyboard.press("Enter");
    assert.equal(await code.textContent(), "if x:\n    ");
    await settle();
    await type("print(x)");
    await page.keyboard.press("Enter");
    assert.equal(await code.textContent(), "if x:\n    print(x)\n    ");
    await page.keyboard.press("Shift+Tab");
    await type("else:");
    await page.keyboard.press("Enter");
    assert.equal(await code.textContent(), "if x:\n    print(x)\nelse:\n    ");
    await settle();
    await type('print("Hello, world!")');
    const source = 'if x:\n    print(x)\nelse:\n    print("Hello, world!")';
    const keyword = code.getByText("else", { exact: true });
    const color = element => getComputedStyle(element).color;
    const light = await keyword.evaluate(color);
    assert.notEqual(light, await code.evaluate(color));
    await settle();

    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator("html.dark").waitFor();
    const dark = await keyword.evaluate(color);
    assert.notEqual(dark, light);
    assert.notEqual(dark, await code.evaluate(color));
    await settle();

    await language.focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await language.inputValue(), "rust");
    await settle();
    await copy.click();
    await page.getByRole("status").filter({ hasText: "Copied" }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
    await settle();

    await page.waitForFunction(() =>
      document.querySelector(".tiptap").editor.getJSON().content[0]?.attrs.language === "rust" &&
      JSON.parse(localStorage.getItem("code-block-updates") || "[]").length > 0);
    await page.reload({ waitUntil: "commit" });
    assert.equal(await language.inputValue(), "rust");
    assert.equal(await code.textContent(), source);

    await code.getByText('"Hello, world!"', { exact: true }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal(await code.textContent(), source);
    await type("``` ");
    assert.equal(await language.nth(1).inputValue(), "");
    assert.equal(await code.nth(1).textContent(), "");
    await page.keyboard.press("Enter");
    await type("> ");
    await type("```c++");
    await page.keyboard.press("Enter");
    assert.equal(await editor.locator("blockquote").getByRole("combobox").inputValue(), "cpp");
    const nestedCode = editor.locator("blockquote pre code");
    await page.keyboard.insertText("if (x) {\n\tif (y) {");
    await page.keyboard.press("Enter");
    assert.equal(await nestedCode.textContent(), "if (x) {\n\tif (y) {\n\t\t");
    await page.keyboard.press("Control+Enter");
    await type("Outside code");
    assert.equal(await editor.locator("blockquote > p").textContent(), "Outside code");
  } finally {
    await browser?.close();
    await server.close();
  }
});
