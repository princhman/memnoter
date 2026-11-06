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
  page.setDefaultTimeout(5000);
});
after(async () => { await browser?.close(); await server?.close(); });
async function load(width, query = "") {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html${query}`);
  await page.waitForFunction(() => !!window.editor);
}

for (const width of [700, 900, 1400]) {
  test(`long outline remains reachable at ${width}px`, async () => {
    await load(width);
    await page.locator(".toc-dash").first().hover();
    await page.locator(".toc-panel").waitFor();
    const compact = width < 1400;
    if (!compact) assert.equal(await page.locator(".toc").getAttribute("data-compact"), "false");
    if (compact) {
      const bounds = await page.locator(".toc-panel").boundingBox();
      assert.ok(bounds.y >= 80, "panel clears the top bar");
      assert.ok(bounds.y + bounds.height <= 784, "panel stays inside the viewport");
      assert.equal(await page.locator(".toc-item").count(), 190);
      if (screenshots && width === 700) {
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${screenshots}/toc-after-700-light.png` });
        await page.evaluate(() => document.documentElement.classList.add("dark"));
        await page.screenshot({ path: `${screenshots}/toc-after-700-dark.png` });
      }
      // Cross the rail/panel boundary diagonally, then use real wheel events.
      await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + 40, { steps: 12 });
      await page.waitForTimeout(250);
      assert.equal(await page.locator(".toc-panel").count(), 1, "pointer crossing keeps the panel open");
      const noteScroll = await page.locator("main").evaluate(el => el.scrollTop);
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => {
        const panel = document.querySelector(".toc-panel");
        return panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
      });
      assert.equal(await page.locator("main").evaluate(el => el.scrollTop), noteScroll, "wheel stays in the outline");
      const bottom = await page.locator(".toc-panel").evaluate(el => el.scrollTop);
      // Small pixel deltas exercise the same browser path as a trackpad gesture.
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -12);
      await page.waitForFunction(bottom => document.querySelector(".toc-panel").scrollTop < bottom - 50, bottom);
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => {
        const panel = document.querySelector(".toc-panel");
        return panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
      });
    } else {
      // The tall rail must also scroll; otherwise later weeks have no trigger.
      await page.mouse.move(50, 100);
      const rail = await page.locator(".toc-rail").boundingBox();
      await page.mouse.move(rail.x + rail.width - 2, rail.y + rail.height / 2);
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => {
        const rail = document.querySelector(".toc-rail");
        return rail.scrollTop + rail.clientHeight >= rail.scrollHeight - 1;
      });
      await page.locator(".toc-dash").last().hover();
    }
    if (!compact) {
      const panel = await page.locator(".toc-panel").boundingBox();
      await page.mouse.move(panel.x + panel.width - 3, panel.y + panel.height / 2);
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => {
        const panel = document.querySelector(".toc-panel");
        return panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
      });
      assert.equal(await page.locator("main").evaluate(el => el.scrollTop), 0, "wide outline also contains wheel scrolling");
    }
    const last = page.getByRole("button", { name: "Week 10 course topic 18", exact: true }).first();
    await last.focus();
    await page.getByRole("button", { name: "Week 10 topic 18 example", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 10000);
  });
}

test("keyboard can open the panel, reach its last row and return to the first", async () => {
  await load(700);
  await page.locator(".tiptap").focus();
  await page.keyboard.press("Tab");
  await page.locator(".toc-dash").first().focus();
  await page.locator(".toc-panel").waitFor();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("PageDown");
  assert.ok(await page.locator(".toc-panel").evaluate(el => el.scrollTop > 0));
  await page.keyboard.press("End");
  await page.keyboard.press("End");
  assert.match(await page.evaluate(() => document.activeElement.textContent.trim()), /Week 10 topic 18 example/);
  const visible = await page.evaluate(() => {
    const row = document.activeElement.getBoundingClientRect();
    const panel = document.querySelector(".toc-panel").getBoundingClientRect();
    return row.top >= panel.top && row.bottom <= panel.bottom;
  });
  assert.ok(visible);
  await page.keyboard.press("Home");
  assert.match(await page.evaluate(() => document.activeElement.textContent), /Week 1 -/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".toc-panel").count(), 0);
});

test("opening far down the note reveals the active heading without scrolling the note", async () => {
  await load(700);
  await page.evaluate(() => {
    document.querySelectorAll(".tiptap h1")[8].scrollIntoView();
    editor.storage.tableOfContents.scrollHandler();
  });
  await page.waitForFunction(() => document.querySelector('.toc-dash[data-active="true"]')?.getAttribute("aria-label")?.startsWith("Week 9 -"));
  const scroll = await page.locator("main").evaluate(el => el.scrollTop);
  await page.locator(".toc-dash").first().hover();
  await page.locator(".toc-panel").waitFor();
  const active = await page.locator('.toc-item[data-active="true"]').boundingBox();
  const panel = await page.locator(".toc-panel").boundingBox();
  assert.ok(active.y >= panel.y && active.y + active.height <= panel.y + panel.height);
  assert.equal(await page.locator("main").evaluate(el => el.scrollTop), scroll);
});

test("a brief pass over the narrow rail does not open the outline; native iPad uses its own contents", async () => {
  await load(700);
  await page.locator(".toc-dash").first().hover();
  await page.mouse.move(50, 100);
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".toc-panel").count(), 0);
  const native = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  await native.addInitScript(() => { window.webkit = { messageHandlers: { memnoter: { postMessage() {} } } }; });
  await native.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html`);
  await native.waitForFunction(() => !!window.editor);
  assert.equal(await native.locator(".toc").count(), 0);
  await native.close();
});


test("resizing an open outline keeps all headings accessible in a short window", async () => {
  await load(1400);
  await page.locator(".toc-dash").first().hover();
  await page.locator(".toc-panel").waitFor();
  await page.setViewportSize({ width: 500, height: 360 });
  await page.waitForFunction(() => document.querySelectorAll(".toc-item").length === 190);
  const panel = await page.locator(".toc-panel").boundingBox();
  assert.ok(panel.y >= 80 && panel.y + panel.height <= 344);
  assert.ok(panel.x >= 16 && panel.x + panel.width <= 484);
  await page.locator(".toc-item").first().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("main").scrollTop > 10000);
});


for (const query of ["", "?relative"]) {
  test(`long outline uses relative shallow levels and expands branches by hover and focus ${query}`, async () => {
    await load(700, query);
    await page.locator(".toc-dash").first().hover();
    await page.locator(".toc-panel").waitFor();
    assert.equal(await page.locator(".toc-item").count(), 190);
    assert.equal(await page.locator(".toc-dash").count(), 190);
    const first = page.getByRole("button", { name: "Week 1 course topic 1", exact: true }).first();
    await first.hover();
    const before = await first.boundingBox();
    await page.getByRole("button", { name: "Week 1 topic 1 details", exact: true }).first().waitFor();
    assert.equal((await first.boundingBox()).y, before.y, "expanding does not move its parent");
    await page.getByRole("button", { name: "Week 1 topic 1 details", exact: true }).first().hover();
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".toc-item").count(), 192, "moving into children retains the branch");
    const next = page.getByRole("button", { name: "Week 1 course topic 2", exact: true }).first();
    await next.hover();
    const nextBefore = await next.boundingBox();
    await page.getByRole("button", { name: "Week 1 topic 2 details", exact: true }).first().waitFor();
    assert.ok(Math.abs((await next.boundingBox()).y - nextBefore.y) <= 1, "collapsing the previous branch preserves the hovered row");
    assert.equal(await page.getByRole("button", { name: "Week 1 topic 1 details", exact: true }).count(), 0);
    await first.focus();
    assert.equal(await page.getByRole("button", { name: "Week 1 topic 1 details", exact: true }).count(), 2, "focus reveals children in rail and panel");
  });
}

test("a deep active heading keeps its branch expanded when another branch is hovered", async () => {
  await load(700);
  await page.evaluate(() => {
    [...document.querySelectorAll(".tiptap h3")].find(el => el.textContent === "Week 9 topic 10 details").scrollIntoView();
    editor.storage.tableOfContents.scrollHandler();
  });
  await page.waitForFunction(() => document.querySelector('.toc-dash[data-active="true"]')?.getAttribute("aria-label") === "Week 9 topic 10 details");
  await page.locator(".toc-dash").first().hover();
  await page.locator(".toc-panel").waitFor();
  const active = page.locator('.toc-item[data-active="true"]');
  assert.match(await active.textContent(), /Week 9 topic 10 details/);
  const bounds = await active.boundingBox();
  const panel = await page.locator(".toc-panel").boundingBox();
  assert.ok(bounds.y >= panel.y && bounds.y + bounds.height <= panel.y + panel.height);
  await page.getByRole("button", { name: "Week 9 course topic 12", exact: true }).first().hover();
  await page.waitForTimeout(250);
  assert.equal(await active.count(), 1);
});

test("short outlines keep every depth expanded", async () => {
  await load(700, "?short");
  await page.locator(".toc-dash").first().hover();
  await page.locator(".toc-panel").waitFor();
  assert.equal(await page.locator(".toc-item").count(), 7);
  assert.equal(await page.locator(".toc-dash").count(), 7);
});


test("touch opens a long outline and reveals a parent while its title still navigates", async () => {
  const touch = await browser.newPage({ viewport: { width: 900, height: 800 }, hasTouch: true });
  await touch.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contents.html`);
  await touch.waitForFunction(() => !!window.editor);
  await touch.locator(".toc-dash").first().tap();
  await touch.locator(".toc-panel").getByRole("button", { name: "Week 1 course topic 1", exact: true }).tap();
  await touch.locator(".toc-panel").getByRole("button", { name: "Week 1 topic 1 details", exact: true }).waitFor();
  await touch.waitForFunction(() => document.querySelector("main").scrollTop > 0);
  await touch.locator(".toc-panel").getByRole("button", { name: "Week 1 topic 1 details", exact: true }).tap();
  assert.equal(await touch.locator(".toc-panel").count(), 0);
  await touch.close();
});
