import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

// Exercise the actual React node views and modal in Tauri's browser engine.
// Opening and dismissing a preview must preserve the note and keyboard focus.
test("block and inline images open full screen and close without changing the note", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => "editor" in window);
    const src = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 1600, 900);
      context.fillStyle = "black";
      context.fillRect(400, 200, 800, 500);
      return canvas.toDataURL();
    });
    for (const type of ["image", "inlineImage"]) {
      await page.evaluate(({ type, src }) => {
        const image = { type, attrs: { src, alt: "Study diagram", width: 200, height: 113 } };
        editor.commands.setContent({ type: "doc", content: [
          type === "image" ? image : { type: "paragraph", content: [image] },
          { type: "paragraph", content: [{ type: "text", text: "Keep this note" }] },
        ] });
      }, { type, src });
      const image = page.locator(".note-image-host img").first();
      await image.waitFor();
      await page.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
      const before = await page.evaluate(() => editor.getJSON());
      await image.click();
      await page.getByRole("button", { name: "Open image full screen", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Image preview" });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("img", { name: "Study diagram" }).getAttribute("src"), src);
      await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.width >= 899 && bounds.height >= 649, `preview fills the viewport: ${JSON.stringify(bounds)}`);
      const viewport = dialog.locator(".image-preview-viewport");
      await viewport.dblclick({ position: { x: 200, y: 180 } });
      assert.match(await dialog.getByRole("img").getAttribute("style"), /scale\(2.5\)/);
      const area = await viewport.boundingBox();
      await page.mouse.move(area.x + 200, area.y + 180);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 10, area.y + area.height - 10, { steps: 8 });
      await page.mouse.up();
      const pan = await dialog.getByRole("img").getAttribute("style");
      assert.ok(!pan.includes("translate(0px, 0px)"), pan);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(() => editor.view.hasFocus());
      assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);

      await image.dblclick();
      await dialog.waitFor();
      assert.match(await dialog.getByRole("img").getAttribute("style"), /scale\(1\)/, "reopening resets zoom");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);

      // The full-screen image must use the same adapted copy as the note,
      // including when the theme changes while the viewer is open.
      await page.evaluate(type => {
        document.documentElement.classList.add("dark");
        editor.commands.setNodeSelection(type === "image" ? 0 : 1);
        editor.commands.updateAttributes(type, { adaptive: true });
      }, type);
      await page.waitForFunction(() => {
        const img = document.querySelector(".note-image-host img");
        return img.src.startsWith("blob:") && img.complete && img.naturalWidth > 0;
      });
      const darkSource = await image.getAttribute("src");
      const adaptedNote = await page.evaluate(() => editor.getJSON());
      await image.dblclick();
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("img").getAttribute("src"), darkSource,
        "opening the viewer preserves the adapted colours");
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.waitForFunction(previous => {
        const note = document.querySelector(".note-image-host img");
        const preview = document.querySelector('[role="dialog"] img');
        return note.src.startsWith("blob:") && note.src !== previous &&
          preview.src === note.src && preview.complete && preview.naturalWidth > 0;
      }, darkSource);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => editor.getJSON()), adaptedNote);
    }
    const touch = await browser.newPage({ viewport: { width: 820, height: 1000 }, hasTouch: true });
    await touch.addInitScript(() => { window.webkit = { messageHandlers: { memnoter: { postMessage() {} } } }; });
    await touch.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await touch.waitForFunction(() => "editor" in window);
    await touch.evaluate(src => editor.commands.setContent({ type: "doc", content: [{ type: "image", attrs: { src, alt: "Touch diagram", width: 200, height: 113 } }] }), src);
    await touch.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
    await touch.getByRole("button", { name: "Preview image", exact: true }).tap();
    const touchDialog = touch.getByRole("dialog", { name: "Image preview" });
    await touchDialog.waitFor();
    await touchDialog.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const touchBounds = await touchDialog.locator(".image-preview-viewport").boundingBox();
    for (let i = 0; i < 2; i++) await touch.touchscreen.tap(touchBounds.x + touchBounds.width / 2, touchBounds.y + touchBounds.height / 2);
    assert.match(await touchDialog.getByRole("img").getAttribute("style"), /scale\(2.5\)/);
    await touchDialog.getByRole("button", { name: "Close", exact: true }).tap();
    await touchDialog.waitFor({ state: "hidden" });
    await touch.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
