import { browserHarness } from "./support/browser.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

let server, browser, page;
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
});
after(async () => { await browser?.close(); await server?.close(); });
async function load(query = "?short", width = 900, height = 800, target = page) {
  await target.setViewportSize({ width, height });
  // Resource load can lag the UI under contention; observe the editor below.
  await target.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html${query}`, { waitUntil: "commit" });
  await target.waitForFunction(() => !!window.editor);
  await target.evaluate(() => document.fonts.ready);
}
const popup = () => page.locator(".toc-popup");
const dash = name => page.locator(".toc-rail").getByRole("button", { name, exact: true });
const names = locator => locator.evaluateAll(rows => rows.map(row => row.getAttribute("aria-label")));
const root = week => `Week ${week} - Intro to C Programming`;
const topic = (week, number) => `Week ${week} course topic ${number}`;
const detail = (week, number) => `Week ${week} topic ${number} details`;
const example = (week, number) => `Week ${week} topic ${number} example`;
async function selectHeading(title, body = false) {
  await page.evaluate(({ title, body }) => {
    const item = store.state.find(item => item.textContent === title);
    editor.commands.setTextSelection(body ? item.pos + item.node.nodeSize + 1 : item.pos + 1);
  }, { title, body });
}
async function waitNames(locator, expected) {
  await page.waitForFunction(({ selector, expected }) => JSON.stringify([...document.querySelectorAll(selector)].map(el => el.getAttribute("aria-label"))) === JSON.stringify(expected), { selector: locator, expected });
}

for (const query of ["?short", "?short&relative"]) {
  test(`rail follows the cursor's root section including body selections ${query}`, async () => {
    await load(query);
    // A selection before all headings falls back to the first scroll-active section.
    const first = [root(1), topic(1, 1), detail(1, 1), example(1, 1), topic(1, 2), detail(1, 2), example(1, 2), root(2), topic(2, 1), topic(2, 2)];
    await waitNames(".toc-dash", first);
    await selectHeading(detail(2, 1), true);
    const second = [root(1), topic(1, 1), topic(1, 2), root(2), topic(2, 1), detail(2, 1), example(2, 1), topic(2, 2), detail(2, 2), example(2, 2)];
    await waitNames(".toc-dash", second);
    await selectHeading(root(1));
    await waitNames(".toc-dash", first);
  });
}

test("scroll-active section is the fallback, while an in-section cursor takes precedence", async () => {
  await load();
  await page.evaluate(() => {
    store.setState(items => items.map(item => ({ ...item, isScrolledOver: item.textContent === "Week 2 topic 1 details" })));
  });
  await dash(detail(2, 1)).waitFor();
  assert.equal(await dash(detail(1, 1)).count(), 0);
  await selectHeading(example(1, 2));
  await dash(detail(1, 1)).waitFor();
  assert.equal(await dash(detail(2, 1)).count(), 0);
});

test("popup contains every descendant and highlights exactly its rail subtree", async () => {
  await load();
  await dash(root(1)).hover();
  await waitNames(".toc-popup .toc-item", [root(1), topic(1, 1), detail(1, 1), example(1, 1), topic(1, 2), detail(1, 2), example(1, 2)]);
  await waitNames('.toc-dash[data-related="true"]', [root(1), topic(1, 1), detail(1, 1), example(1, 1), topic(1, 2), detail(1, 2), example(1, 2)]);
  await dash(topic(2, 1)).hover();
  await waitNames(".toc-popup .toc-item", [topic(2, 1), detail(2, 1), example(2, 1)]);
  await waitNames('.toc-dash[data-related="true"]', [topic(2, 1)]);
  await dash(root(2)).hover();
  await waitNames(".toc-popup .toc-item", [root(2), topic(2, 1), detail(2, 1), example(2, 1), topic(2, 2), detail(2, 2), example(2, 2)]);
  await waitNames('.toc-dash[data-related="true"]', [root(2), topic(2, 1), topic(2, 2)]);
  await selectHeading(detail(2, 1));
  await dash(topic(2, 1)).hover();
  await waitNames(".toc-popup .toc-item", [topic(2, 1), detail(2, 1), example(2, 1)]);
  await waitNames('.toc-dash[data-related="true"]', [topic(2, 1), detail(2, 1), example(2, 1)]);
  await page.mouse.move(0, 0);
  await waitNames('.toc-dash[data-related="true"]', []);
});

test("two-level notes include children with their own dash in the popup", async () => {
  await load();
  await page.evaluate(() => editor.commands.setContent("<h2>One</h2><h4>Child</h4><h2>Two</h2><h4>Other</h4>"));
  await waitNames(".toc-dash", ["One", "Child", "Two", "Other"]);
  await dash("Two").hover();
  await waitNames(".toc-popup .toc-item", ["Two", "Other"]);
});

for (const width of [360, 700, 1400]) {
  test(`dense rail fits without scrolling and scrubs to exactly the pointed dash at ${width}px`, async () => {
    await load("", width, 360);
    assert.ok(await page.locator(".toc-rail").getByRole("button").count() > 100, "exercise a dense outline");
    const bounds = await page.locator(".toc-rail").boundingBox();
    assert.ok(bounds.height <= 216.1);
    assert.ok(await page.locator(".toc-rail").evaluate(el => el.scrollHeight <= el.clientHeight + 1));
    for (const fraction of [0.03, 0.5, 0.97]) {
      const x = bounds.x + bounds.width - 2;
      const y = bounds.y + bounds.height * fraction;
      // Dense rows can be smaller than a device pixel. Assert against the
      // browser's actual event target, which includes its input rounding.
      await page.evaluate(() => {
        window.railTitle = null;
        document.addEventListener("pointermove", event => {
          window.railTitle = event.target.closest(".toc-dash")?.getAttribute("aria-label");
        }, { once: true });
      });
      await page.mouse.move(x, y);
      const title = await page.evaluate(() => window.railTitle);
      assert.ok(title);
      await page.waitForFunction(title => document.querySelector(".toc-popup .toc-item")?.getAttribute("aria-label") === title, title);
      const box = await popup().boundingBox();
      assert.ok(box.x >= 16 && box.x + box.width <= width - 16);
      assert.ok(box.y >= 80 && box.y + box.height <= 344.1);
    }
    assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0);
  });
}

test("popup can be entered and a hidden descendant click navigates", async () => {
  await load();
  await dash(topic(2, 1)).hover();
  const child = popup().getByRole("button", { name: detail(2, 1), exact: true });
  await child.hover();
  await page.waitForTimeout(400);
  assert.equal(await popup().count(), 1);
  await child.click();
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 100);
  await popup().waitFor({ state: "detached" });
});

test("keyboard moves between dashes, enters children, and Escape closes and restores focus", async () => {
  await load();
  await page.keyboard.press("Tab");
  await dash(root(2)).focus();
  await popup().waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), topic(2, 1));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector(".toc-popup")?.contains(document.activeElement));
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), example(2, 1));
  await page.keyboard.press("Escape");
  await popup().waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), topic(2, 1));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 100);
});

test("touch first tap opens, second tap navigates; native host still omits the TOC", async () => {
  const touch = await browser.newPage({ hasTouch: true });
  await load("?short", 900, 800, touch);
  const target = touch.locator(".toc-rail").getByRole("button", { name: topic(2, 1), exact: true });
  await target.tap();
  await touch.locator(".toc-popup").waitFor();
  assert.equal(await touch.locator("main").evaluate(el => el.scrollTop), 0);
  await target.tap();
  await touch.waitForFunction(() => document.querySelector("main").scrollTop > 100);
  await touch.locator(".toc-popup").waitFor({ state: "detached" });
  await touch.close();
  const native = await browser.newPage();
  await native.addInitScript(() => { window.installTestBridge({ native: function() {} }); });
  await load("?short", 900, 800, native);
  assert.equal(await native.locator(".toc").count(), 0);
  await native.close();
});

test("popup renders numbered titles", async () => {
  await load("?short&numbered");
  await page.locator(".toc-dash").first().hover();
  await popup().waitFor();
  assert.deepEqual(await names(popup().locator(".toc-item")), [
    `1 ${root(1)}`, `1.1 ${topic(1, 1)}`, `1.1.1 ${detail(1, 1)}`, `1.1.1.1 ${example(1, 1)}`,
    `1.2 ${topic(1, 2)}`, `1.2.1 ${detail(1, 2)}`, `1.2.1.1 ${example(1, 2)}`,
  ]);
});

test("menu aim protects diagonal travel, releases outside the triangle, and expires when still", async () => {
  await load();
  // Pause ahead of the browser's clock rather than racing the host's wall clock.
  await page.clock.install({ time: 0 });
  try {
  await page.clock.pauseAt(60_000);
  const first = await dash(root(1)).boundingBox();
  const second = await dash(topic(1, 1)).boundingBox();
  const start = { x: first.x + first.width - 1, y: first.y + first.height / 2 };
  const crossing = { x: start.x - 10, y: second.y + second.height / 2 };
  const waitTitle = title => page.waitForFunction(title => document.querySelector(".toc-popup .toc-item")?.getAttribute("aria-label") === title, title, { polling: 10 });
  await page.mouse.move(start.x, start.y);
  await popup().waitFor();
  await page.mouse.move(crossing.x, crossing.y);
  await waitTitle(root(1));
  // Back toward the rail leaves the safe triangle and switches immediately.
  await page.mouse.move(start.x, crossing.y);
  await waitTitle(topic(1, 1));
  // Vertical scrubbing switches without waiting for the aim timeout.
  await page.mouse.move(start.x, start.y);
  await waitTitle(root(1));
  await page.mouse.move(crossing.x, crossing.y);
  await waitTitle(root(1));
  await page.clock.runFor(1000);
  await waitNames(".toc-popup .toc-item", [topic(1, 1), detail(1, 1), example(1, 1)]);
  // Entering the popup cancels the pending switch.
  await page.mouse.move(start.x, start.y);
  await waitTitle(root(1));
  await page.mouse.move(crossing.x, crossing.y);
  const box = await popup().boundingBox();
  await page.mouse.move(box.x + box.width - 2, crossing.y);
  await page.clock.runFor(200);
  await waitTitle(root(1));
  } finally { await page.clock.resume(); }
});

test("long subtree popup scrolls internally and reveals its active heading", async () => {
  await load("?short&deep", 900, 360);
  await selectHeading(root(1));
  await page.evaluate(() => {
    store.setState(items => items.map(item => ({ ...item, isScrolledOver: item.textContent === "Week 1 topic 1 example 24" })));
  });
  await dash(root(1)).hover();
  await popup().waitFor();
  assert.ok(await popup().getByRole("button").count() > 40, "subtree exceeds the visible popup");
  const box = await popup().boundingBox();
  assert.ok(box.y >= 80 && box.y + box.height <= 344.1);
  assert.ok(await popup().evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
  const active = await popup().locator('[data-active="true"]').boundingBox();
  assert.ok(active.y >= box.y && active.y + active.height <= box.y + box.height + 1);
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0);
  await popup().hover();
  await page.mouse.wheel(0, 1000);
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0);
});

test("descendants preserve relative indentation and render inline math", async () => {
  await load("?short&numbered");
  await page.evaluate(() => editor.commands.setContent('<h1>Root</h1><h3>Formula <span data-type="inline-math">x^2</span></h3><h4>Detail</h4><h1>Sibling</h1>'));
  await dash("1 Root").hover();
  await waitNames(".toc-popup .toc-item", ["1 Root", "1.1 Formula x^2", "1.1.1 Detail"]);
  assert.equal(await popup().locator(".katex").count(), 1);
  assert.equal(await popup().locator(".katex annotation").textContent(), "x^2");
  const indentation = await popup().locator(".toc-item").evaluateAll(rows => rows.map(row => {
    const range = document.createRange(); range.selectNodeContents(row); return range.getBoundingClientRect().left;
  }));
  assert.ok(indentation[0] < indentation[1] && indentation[1] < indentation[2]);
  await popup().getByRole("button", { name: "1.1.1 Detail", exact: true }).click();
  await popup().waitFor({ state: "detached" });
  await waitNames('.toc-dash[data-related="true"]', []);
});

test("hover reveals the chosen Contents focus action and keyboard unfocus restores the note", async () => {
  await load();
  await selectHeading(root(1));
  await dash(root(2)).hover();
  await popup().getByRole("button", { name: root(2), exact: true }).hover();
  await popup().getByRole("button", { name: `Focus on ${root(2)}`, exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.section-focus-start'));
  assert.equal(await page.locator('.section-focus-start').textContent(), root(2));
  assert.equal(await page.locator('.tiptap h1').filter({ hasText: root(1) }).isVisible(), false);
  await popup().waitFor({ state: "detached" });
  const top = await page.locator('.section-focus-start').evaluate(node => node.getBoundingClientRect().top);
  await page.mouse.move(0, 0);
  await dash(root(2)).hover();
  await waitNames(".toc-popup .toc-item", [root(2), topic(2, 1), detail(2, 1), example(2, 1), topic(2, 2), detail(2, 2), example(2, 2)]);
  const unfocus = popup().getByRole("button", { name: `Unfocus ${root(2)}`, exact: true });
  await unfocus.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector('.section-focused'));
  assert.equal(await page.locator('.tiptap h1').filter({ hasText: root(1) }).isVisible(), true);
  await popup().waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), root(2));
  const restored = await page.locator('.tiptap h1').filter({ hasText: root(2) }).evaluate(node => node.getBoundingClientRect().top);
  assert.ok(Math.abs(restored - top) <= 1, 'Unfocus retains the section on screen');
});
