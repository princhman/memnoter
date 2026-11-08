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
