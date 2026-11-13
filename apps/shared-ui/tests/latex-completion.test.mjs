import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, page;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  page.on("pageerror", console.error);
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/latex.html`);
  await page.waitForFunction(() => "editor" in window);
});
after(async () => { await browser?.close(); await server?.close(); });

test("Tab completes an opened dollar formula without leaving extra dollars", async () => {
  await page.locator(".tiptap").click();
  await page.keyboard.type("$\\alp");
  await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor();
  await page.keyboard.press("Tab");
  const result = await page.evaluate(() => ({
    content: editor.getJSON().content[0].content,
    parent: editor.state.selection.$from.parent.type.name,
    offset: editor.state.selection.$from.parentOffset,
  }));
  assert.deepEqual(result.content, [{ type: "inlineMath", content: [{ type: "text", text: "\\alpha" }] }]);
  assert.equal(result.parent, "inlineMath");
  assert.equal(result.offset, 6);
});

for (const [source, tex, trailing] of [
  ["$\\alp$", "\\alpha", ""],
  ["$a+\\alp", "a+\\alpha", ""],
  ["$a+\\alp+b$ tail", "a+\\alpha+b", " tail"],
  ["\\alp", "\\alpha", ""],
]) {
  test(`Tab completion in ${JSON.stringify(source)} preserves source and caret`, async () => {
    await page.evaluate((source) => {
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: source }] }] });
      editor.commands.focus();
      editor.commands.setTextSelection(source.indexOf("\\alp") + 5);
    }, source);
    await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor();
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => ({
      content: editor.getJSON().content[0].content,
      parent: editor.state.selection.$from.parent.type.name,
      offset: editor.state.selection.$from.parentOffset,
    }));
    const expected = [{ type: "inlineMath", content: [{ type: "text", text: tex }] }];
    if (trailing) expected.push({ type: "text", text: trailing });
    assert.deepEqual(result.content, expected);
    assert.equal(result.parent, "inlineMath");
    assert.equal(result.offset, tex.indexOf("\\alpha") + 6);
  });
}

test("Tab keeps command-template caret slots inside math", async () => {
  await page.evaluate(() => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.focus();
  });
  await page.keyboard.type("$\\fra");
  await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor();
  await page.keyboard.press("Tab");
  const result = await page.evaluate(() => ({ text: editor.state.selection.$from.parent.textContent, offset: editor.state.selection.$from.parentOffset }));
  assert.deepEqual(result, { text: "\\frac{}{}", offset: 6 });
});

test("editor inline and block renders group scripts without rewriting stored source", async () => {
  for (const type of ["inlineMath", "mathBlock"]) {
    await page.evaluate(type => {
      const math = { type, content: [{ type: "text", text: "a^qbc" }] };
      editor.commands.setContent({ type: "doc", content: type === "inlineMath"
        ? [{ type: "paragraph", content: [math] }, { type: "paragraph" }]
        : [math, { type: "paragraph" }] });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    }, type);
    await page.waitForFunction(() => document.querySelector(".katex annotation")?.textContent === "a^{qbc}");
    assert.equal(await page.evaluate(() => editor.state.doc.textContent), "a^qbc");
  }
});

test("review cards render the same script shorthand", async () => {
  const annotations = await page.locator("#card-math annotation").allTextContents();
  assert.deepEqual(annotations, ["a^{qbc}", "a_{qbc}"]);
});

test("completion within existing math preserves its node and caret", async () => {
  await page.evaluate(() => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "inlineMath", content: [{ type: "text", text: "a+\\alp" }] },
    ] }] });
    editor.commands.focus();
    editor.commands.setTextSelection(8);
  });
  await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor();
  await page.keyboard.press("Tab");
  assert.deepEqual(await page.evaluate(() => ({
    text: editor.state.selection.$from.parent.textContent,
    offset: editor.state.selection.$from.parentOffset,
    count: editor.state.doc.firstChild.childCount,
  })), { text: "a+\\alpha", offset: 8, count: 1 });
});

test("typing a closing dollar still converts plain source to math", async () => {
  await page.evaluate(() => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    editor.commands.focus();
  });
  await page.keyboard.type("$a^qbc$");
  assert.deepEqual(await page.evaluate(() => editor.getJSON().content[0].content), [
    { type: "inlineMath", content: [{ type: "text", text: "a^qbc" }] },
  ]);
});

test("PRI-341: native copy of selected LaTeX source copies the selected text", async () => {
  await page.evaluate(() => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "inlineMath", content: [{ type: "text", text: "a+\\alpha+b" }] },
    ] }] });
    editor.view.focus();
    editor.commands.setTextSelection(10);
  });
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+c");
  await page.evaluate(() => {
    const input = document.createElement("textarea");
    input.id = "clipboard-target";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("ControlOrMeta+v");
  assert.equal(await page.locator("#clipboard-target").inputValue(), "\\alpha");
  await page.locator("#clipboard-target").evaluate(element => element.remove());
});

test("PRI-346: Enter dismisses completion and keeps editing the unchanged formula", async () => {
  for (const tex of ["\\cup", "\\cu"]) {
    await page.evaluate(tex => {
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
        { type: "inlineMath", content: [{ type: "text", text: tex }] },
      ] }] });
      editor.view.focus();
      editor.commands.setTextSelection(2 + tex.length);
    }, tex);
    await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => ({
      text: editor.state.selection.$from.parent.textContent,
      parent: editor.state.selection.$from.parent.type.name,
    })), { text: tex, parent: "inlineMath" });
    await page.keyboard.type("+b");
    assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.textContent), tex + "+b");
  }
  await page.evaluate(() => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "inlineMath", content: [{ type: "text", text: "\\qqqqqqqq" }] },
    ] }] });
    editor.view.focus();
    editor.commands.setTextSelection(11);
  });
  await page.getByRole("listbox", { name: "LaTeX commands" }).waitFor({ state: "hidden" });
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => editor.state.selection.$from.parent.type.name), "paragraph");
});

test("PRI-365: escaped dollars stay literal through later typing, reload and native copy", async () => {
  await page.evaluate(() => { editor.commands.clearContent(); editor.commands.focus(); });
  await page.keyboard.type("\\$rt \\$ra ");
  assert.equal(await page.locator(".tiptap").innerText(), "$rt $ra ");
  await page.keyboard.type("$x$");
  const saved = await page.evaluate(() => editor.getJSON());
  assert.equal(saved.content[0].content.filter(node => node.type === "inlineMath").length, 1);
  assert.equal(saved.content[0].content.at(-1).content[0].text, "x");
  await page.evaluate(saved => {
    editor.commands.setContent(saved);
    editor.commands.setTextSelection({ from: 1, to: 9 });
    editor.view.focus();
  }, saved);
  await page.keyboard.press("ControlOrMeta+c");
  await page.evaluate(() => {
    const input = document.createElement("textarea"); input.id = "literal-copy";
    document.body.append(input); input.focus();
  });
  await page.keyboard.press("ControlOrMeta+v");
  assert.equal(await page.locator("#literal-copy").inputValue(), "$rt $ra ");
  await page.locator("#literal-copy").evaluate(el => el.remove());
});

test("PRI-365: legacy escapes become literal dollars except in code", async () => {
  await page.evaluate(() => editor.commands.setContent('<p>\\$rt \\$ra </p><pre><code>\\$code</code></pre>'));
  assert.equal(await page.locator(".tiptap p").first().innerText(), "$rt $ra");
  assert.equal(await page.locator(".tiptap pre").innerText(), "\\$code");
});
