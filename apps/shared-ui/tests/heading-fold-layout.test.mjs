import { browserHarness } from "./support/browser.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

// The fold toggle is absolutely positioned in the heading's left gutter. A
// stylesheet change once dropped its horizontal anchor, so it drew over the
// heading number instead. Check the real rendered layout, not the CSS text.
test("heading fold toggles sit left of numbered heading text", { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, logLevel: "error", server: { port: 0, strictPort: false, hmr: false, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/large-note.html`);
    await page.waitForFunction(() => !!window.openLargeNote);
    const text = "# Properties\n\nIntro.\n\n## Sub-property\n\nDetail.\n";
    await page.evaluate(text => window.openLargeNote({ name: "Fold", entries: [{ path: "Fold.md", text }] }), text);
    const layouts = await page.evaluate(() => [...document.querySelectorAll(".tiptap :is(h1, h2, h3)")]
      .filter(heading => heading.querySelector(".heading-fold-toggle"))
      .map(heading => {
        const toggle = heading.querySelector(".heading-fold-toggle").getBoundingClientRect();
        const number = heading.querySelector(".heading-number")?.getBoundingClientRect();
        return { heading: heading.textContent, toggleRight: toggle.right, textLeft: number?.left ?? heading.getBoundingClientRect().left, numbered: !!number };
      }));
    assert.ok(layouts.length >= 2, "both headings with content get a fold toggle");
    assert.ok(layouts.every(layout => layout.numbered), "headings are numbered");
    for (const layout of layouts) {
      assert.ok(layout.toggleRight <= layout.textLeft + 0.5, `toggle overlaps "${layout.heading}": ${layout.toggleRight} > ${layout.textLeft}`);
    }
  } finally {
    await browser?.close();
    await server.close();

  }
});

test("PRI-379 heading folds hide foldable blocks and preserve their open state", { timeout: 60_000 }, async () => {
  const server = await createServer({ logLevel: "error", server: { port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
    await page.waitForFunction(() => window.editor);
    for (const open of [true, false]) {
      await page.evaluate(open => {
        editor.commands.setContent(`<h1>Chapter</h1><h2>Assembly</h2><h3>Calling conventions</h3><h4>Functions</h4><details ${open ? 'open' : ''}><summary>Function example using register conventions</summary><div data-type="detailsContent"><p>Example body</p></div></details><h3>Stack</h3><p>Next section</p>`);
        editor.commands.setTextSelection(1);
      }, open);
      const block = page.locator('.foldable-block');
      assert.equal(await block.isVisible(), true);
      if (process.env.PROOF_DIR) await page.waitForTimeout(500);
      await page.locator('h4 .heading-fold-toggle').click();
      if (process.env.PROOF_DIR) await page.waitForTimeout(500);
      assert.equal(await block.isVisible(), false, 'entire block disappears with its heading section');
      assert.equal(await page.getByRole('heading', { name: 'Stack', exact: false }).isVisible(), true, 'next higher heading remains visible');
      await page.locator('h4 .heading-fold-toggle').click();
      assert.equal(await block.isVisible(), true);
      assert.equal(await page.evaluate(() => editor.state.doc.child(4).attrs.open), open);
      if (process.env.PROOF_DIR) await page.waitForTimeout(500);
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
