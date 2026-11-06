import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

let server, browser, page;
const screenshots = process.env.TOC_SCREENSHOTS;
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
});
after(async () => { await browser?.close(); await server?.close(); });
async function load(width = 700, query = "", height = 800) {
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width, height });
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html${query}`);
  await page.waitForFunction(() => !!window.editor);
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".toc-dash").first().hover();
  await page.locator(".toc-panel").waitFor();
  await page.waitForTimeout(150);
}
const panel = () => page.locator(".toc-panel");
const flyout = () => page.locator(".toc-flyout");
const parent = name => panel().getByRole("button", { name, exact: true });
const positions = () => panel().locator(".toc-item").evaluateAll(rows => rows.map(row => ({ name: row.getAttribute("aria-label"), y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height })));
async function insideViewport(locator) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds.x >= 16 && bounds.x + bounds.width <= viewport.width - 16);
  assert.ok(bounds.y >= 80 && bounds.y + bounds.height <= viewport.height - 16);
  return bounds;
}
async function scrollToEnd(locator) {
  const bounds = await locator.boundingBox();
  await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 10 });
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
  await page.waitForFunction(selector => {
    const list = document.querySelector(selector);
    return list && list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  }, `.${await locator.getAttribute("class")}`);
}

for (const width of [700, 900, 1400]) {
  test(`flyout stays on screen and hovering never moves main rows at ${width}px`, async () => {
    await load(width);
    assert.equal(await panel().locator(".toc-item").count(), 190);
    assert.equal(await page.locator(".toc-dash").count(), 190);
    const before = await positions();
    await parent("Week 1 course topic 1").hover();
    await flyout().waitFor();
    assert.deepEqual(await positions(), before, "every main row stays in exactly the same position");
    const bounds = await insideViewport(flyout());
    const main = await panel().boundingBox();
    assert.ok(bounds.x + bounds.width <= main.x, "flyout uses the free side of the panel");
    assert.equal(await flyout().locator(".toc-item").count(), 2);
    if (screenshots && width !== 900) {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${screenshots}/toc-flyout-${width}.png` });
    }
    await parent("Week 1 course topic 2").focus();
    assert.deepEqual(await positions(), before, "changing branches and focus cannot move the main list");
    assert.equal(await flyout().locator(".toc-item").count(), 2);
  });
}

test("an H1 with visible H2 children has no flyout and highlights only its own row and dash", async () => {
  await load();
  const root = parent("Week 1 - Intro to C Programming");
  assert.equal(await root.locator("..").locator(".toc-branch-trigger").count(), 0);
  await root.hover();
  await page.waitForTimeout(250);
  assert.equal(await flyout().count(), 0);
  await root.focus();
  assert.equal(await flyout().count(), 0);
  assert.equal(await page.locator('.toc-dash[data-related="true"]').count(), 1);
  assert.equal(await page.locator('.toc-dash[data-related="true"]').getAttribute("aria-label"), "Week 1 - Intro to C Programming");
  assert.equal(await panel().locator('[data-hover="true"]').count(), 1);
  await parent("Week 1 course topic 1").hover();
  await flyout().waitFor();
  const mainNames = await panel().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label")));
  const hiddenNames = await flyout().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label")));
  assert.deepEqual(hiddenNames, ["Week 1 topic 1 details", "Week 1 topic 1 example"]);
  assert.ok(hiddenNames.every(name => !mainNames.includes(name)), "flyouts never repeat visible headings");
  assert.equal(await page.locator('.toc-dash[data-related="true"]').count(), 1);
  await flyout().getByRole("button", { name: "Week 1 topic 1 details", exact: true }).hover();
  assert.equal(await page.locator('.toc-row[data-hover="true"]').count(), 1);
  assert.equal(await panel().locator('[data-hover="true"]').count(), 0);
});

for (const query of ["?direct", "?direct&relative"]) {
  test(`a root flyout shows only its own hidden descendants ${query}`, async () => {
    await load(700, query);
    const root = parent("Week 1 - Intro to C Programming");
    await root.hover();
    await flyout().waitFor();
    assert.deepEqual(await flyout().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))), ["Direct details", "Direct example"]);
    assert.equal(await panel().locator(".toc-item").count(), 190);
    await page.evaluate(() => {
      [...document.querySelectorAll(".tiptap :is(h4,h5)")].find(el => el.textContent === "Direct example").scrollIntoView();
      editor.storage.tableOfContents.scrollHandler();
    });
    await page.waitForFunction(() => document.querySelector('.toc-panel [data-active="true"]')?.getAttribute("aria-label") === "Week 1 - Intro to C Programming");
    assert.equal(await flyout().locator('[data-active="true"]').getAttribute("aria-label"), "Direct example");
    await parent("Week 1 course topic 1").focus();
    assert.deepEqual(await flyout().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))), ["Week 1 topic 1 details", "Week 1 topic 1 example"]);
  });
}

test("a slow diagonal pointer path into the flyout does not switch branches or close it", async () => {
  await load(700, "?deep");
  const row = parent("Week 1 course topic 1");
  await row.hover();
  await flyout().waitFor();
  const label = await flyout().getAttribute("aria-label");
  const main = await panel().boundingBox();
  const child = await flyout().boundingBox();
  const anchor = await row.boundingBox();
  await page.mouse.move(anchor.x + anchor.width / 2 - 1, anchor.y + anchor.height / 2);
  await page.mouse.move(main.x + 25, main.y + 130, { steps: 10 });
  await page.waitForTimeout(450);
  assert.equal(await flyout().getAttribute("aria-label"), label);
  await page.mouse.move(child.x + child.width - 12, child.y + 250, { steps: 12 });
  await page.waitForTimeout(450);
  assert.equal(await flyout().getAttribute("aria-label"), label);
  assert.equal(await flyout().count(), 1);
});

test("keyboard enters the flyout and Left or Escape returns to its disclosure", async () => {
  await load();
  const row = parent("Week 1 course topic 1");
  await row.focus();
  await flyout().waitFor();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await flyout().count(), 0);
  assert.equal(await panel().count(), 1, "Left from the parent closes only the flyout");
  await row.focus();
  await flyout().waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await flyout().count(), 0);
  assert.equal(await panel().count(), 1, "Escape from the parent closes only the flyout");
  await page.keyboard.press("ArrowRight");
  assert.ok(await flyout().evaluate(el => el.contains(document.activeElement)));
  await page.keyboard.press("ArrowLeft");
  assert.equal(await flyout().count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Show sections in Week 1 course topic 1");
  await page.keyboard.press("Enter");
  await flyout().waitFor();
  assert.ok(await flyout().evaluate(el => el.contains(document.activeElement)));
  await page.keyboard.press("Escape");
  assert.equal(await flyout().count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Show sections in Week 1 course topic 1");
});

test("wheel and small pixel deltas scroll the flyout independently and reach its last descendant", async () => {
  await load(700, "?deep");
  await parent("Week 1 course topic 1").hover();
  await flyout().waitFor();
  const mainPositions = await positions();
  await scrollToEnd(flyout());
  const bottom = await flyout().evaluate(el => el.scrollTop);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -12);
  await page.waitForFunction(bottom => document.querySelector(".toc-flyout").scrollTop < bottom - 50, bottom);
  await scrollToEnd(flyout());
  assert.deepEqual(await positions(), mainPositions);
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0);
  await flyout().getByRole("button", { name: "Week 1 topic 1 example 24", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 1000);
});

for (const width of [700, 1400]) {
  test(`the final heading of ten weeks is reachable and clickable at ${width}px`, async () => {
    await load(width);
    await scrollToEnd(panel());
    assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0);
    const row = parent("Week 10 course topic 18");
    await row.focus();
    await page.keyboard.press("ArrowRight");
    await flyout().waitFor();
    await insideViewport(flyout());
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Week 10 topic 18 example");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 10000);
  });
}

test("deep active headings mark a stable ancestor and are highlighted and visible in its flyout", async () => {
  await load();
  const names = await panel().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label")));
  await page.evaluate(() => {
    [...document.querySelectorAll(".tiptap h3")].find(el => el.textContent === "Week 9 topic 10 details").scrollIntoView();
    editor.storage.tableOfContents.scrollHandler();
  });
  await page.waitForFunction(() => document.querySelector('.toc-panel [data-active="true"]')?.getAttribute("aria-label") === "Week 9 course topic 10");
  assert.deepEqual(await panel().locator(".toc-item").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))), names);
  const before = await positions();
  await parent("Week 9 course topic 10").hover();
  await flyout().waitFor();
  assert.deepEqual(await positions(), before);
  assert.equal(await flyout().locator('[data-active="true"]').getAttribute("aria-label"), "Week 9 topic 10 details");
  const active = await flyout().locator('[data-active="true"]').boundingBox();
  const bounds = await flyout().boundingBox();
  assert.ok(active.y >= bounds.y && active.y + active.height <= bounds.y + bounds.height);
});

test("title tooltips appear only for truncated text and sit outside both lists", async () => {
  await load();
  await parent("Week 1 course topic 1").hover();
  await page.waitForTimeout(650);
  assert.equal(await page.getByRole("tooltip").count(), 0);
  assert.equal(await panel().locator("[title]").count(), 0, "native titles cannot cover neighbouring rows");
  const title = "A long title about compilation and the many steps that a programmer takes to build a program";
  const long = parent(title).first();
  await long.hover();
  await page.getByRole("tooltip").waitFor();
  assert.ok(await long.locator(".toc-item-title").evaluate(el => el.scrollWidth > el.clientWidth));
  const tip = await page.getByRole("tooltip").boundingBox();
  for (const list of [panel(), flyout()]) {
    const bounds = await list.boundingBox();
    assert.ok(tip.y + tip.height <= bounds.y || tip.y >= bounds.y + bounds.height, "tooltip never covers list rows");
  }
});

test("a truncated short-outline title gets a tooltip without opening a flyout", async () => {
  await load(700, "?short");
  const title = "A long title about compilation and the many steps that a programmer takes to build a program";
  await page.evaluate(title => editor.commands.setContent(`<h1>${title}</h1><p>Body</p>`), title);
  await parent(title).waitFor();
  await parent(title).hover();
  await page.getByRole("tooltip").waitFor();
  assert.equal(await flyout().count(), 0);
  assert.equal(await page.getByRole("tooltip").textContent(), title);
});

for (const query of ["?relative", "?short"]) {
  test(`relative depth and short-outline behavior remain intact ${query}`, async () => {
    await load(700, query);
    assert.equal(await panel().locator(".toc-item").count(), query === "?short" ? 7 : 190);
    if (query === "?short") assert.equal(await panel().locator(".toc-branch-trigger").count(), 0);
    else {
      await parent("Week 1 course topic 1").hover();
      await flyout().waitFor();
      assert.equal(await flyout().locator(".toc-item").count(), 2);
    }
  });
}

test("a short viewport uses a clean overlay when there is no side space", async () => {
  await load(360, "?deep", 360);
  await parent("Week 1 course topic 1").focus();
  await page.keyboard.press("ArrowRight");
  await flyout().waitFor();
  assert.equal(await flyout().getAttribute("data-side"), "overlay");
  await insideViewport(flyout());
  await flyout().getByRole("button", { name: "Back to outline" }).click();
  assert.equal(await flyout().count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Show sections in Week 1 course topic 1");
  await page.keyboard.press("Enter");
  await flyout().waitFor();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 1000);
});

test("touch disclosure opens the flyout while the row still navigates; native iPad is unchanged", async () => {
  await load();
  const touch = await browser.newPage({ viewport: { width: 900, height: 800 }, hasTouch: true });
  await touch.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html`);
  await touch.waitForFunction(() => !!window.editor);
  await touch.locator(".toc-dash").first().tap();
  await touch.locator(".toc-panel").getByRole("button", { name: "Show sections in Week 1 course topic 1", exact: true }).tap();
  await touch.locator(".toc-flyout").getByRole("button", { name: "Week 1 topic 1 details", exact: true }).tap();
  await touch.waitForFunction(() => document.querySelector("main").scrollTop > 0);
  assert.equal(await touch.locator(".toc-panel").count(), 0);
  await touch.close();
  await parent("Week 1 course topic 2").click();
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 0);
  const native = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  await native.addInitScript(() => { window.webkit = { messageHandlers: { memnoter: { postMessage() {} } } }; });
  await native.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html`);
  await native.waitForFunction(() => !!window.editor);
  assert.equal(await native.locator(".toc").count(), 0);
  await native.close();
});
