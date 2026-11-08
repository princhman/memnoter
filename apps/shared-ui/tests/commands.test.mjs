import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesCommand } from "../src/lib/commands.ts";

import { browserHarness } from "./support/browser.mjs";
import { fileURLToPath } from "node:url";
const { createServer, webkit } = browserHarness(import.meta.url);

test("registered commands update the rendered subscriber and obsolete cleanup preserves replacements", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch(); const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contrast.html`);
    await page.evaluate(async () => {
      const { mountCommands, registerCommand } = await import('/tests/browser/command-subscriber.tsx');
      mountCommands(document.querySelector('#audit'));
      window.first = registerCommand({ id: 'x', title: 'First', run() {} });
      window.second = registerCommand({ id: 'x', title: 'Second', run() {} });
    });
    await page.getByRole('listitem').filter({ hasText: 'Second' }).waitFor();
    assert.equal(await page.getByRole('listitem').count(), 1);
    await page.evaluate(() => first());
    assert.deepEqual(await page.getByRole('listitem').allTextContents(), ['Second']);
    await page.evaluate(() => second());
    await page.getByRole('listitem').waitFor({ state: 'detached' });
  } finally { await browser?.close(); await server.close(); }
});

test("every query word must start a word of the title or keywords", () => {
  const command = { id: "module.new", title: "New module", keywords: ["create"], run() {} };
  for (const query of ["new", "mod", "NEW MOD", "create", "cr mo", ""]) {
    assert.ok(matchesCommand(command, query), query);
  }
  for (const query of ["odule", "new x", "sidebar"]) {
    assert.ok(!matchesCommand(command, query), query);
  }
});
