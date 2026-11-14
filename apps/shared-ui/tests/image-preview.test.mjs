import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

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
      await page.getByRole("button", { name: "Image actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Open image full screen", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Image preview" });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("img", { name: "Study diagram" }).getAttribute("src"), src);
      await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.width >= 899 && bounds.height >= 649, `preview fills the viewport: ${JSON.stringify(bounds)}`);
      const viewport = dialog.locator(".image-preview-viewport");
      const fitted = await dialog.getByRole("img").boundingBox();
      await viewport.dblclick({ position: { x: 200, y: 180 } });
      const zoomed = await dialog.getByRole("img").boundingBox();
      assert.ok(zoomed.width > fitted.width && zoomed.height > fitted.height);
      const area = await viewport.boundingBox();
      await page.mouse.move(area.x + 200, area.y + 180);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 10, area.y + area.height - 10, { steps: 8 });
      await page.mouse.up();
      const panned = await dialog.getByRole("img").boundingBox();
      assert.ok(Math.abs(panned.x - zoomed.x) > 1 || Math.abs(panned.y - zoomed.y) > 1);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(() => editor.view.hasFocus());
      assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);

      await image.dblclick();
      await dialog.waitFor();
      await dialog.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      assert.ok(Math.abs((await dialog.getByRole("img").boundingBox()).width - fitted.width) < 1, "reopening resets zoom");
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
    await touch.addInitScript(() => { window.installTestBridge({ native: function() {} }); });
    await touch.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await touch.waitForFunction(() => "editor" in window);
    await touch.evaluate(src => {
      editor.setOptions({ editorProps: { attributes: { "data-native-editor": "true", inputmode: "none" } } });
      editor.commands.setContent({ type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Tap here afterwards" }] },
        { type: "image", attrs: { src, alt: "Touch diagram", width: 200, height: 113 } },
      ] });
    }, src);
    await touch.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
    await touch.locator(".note-image-host img").tap();
    await touch.locator(".note-image-host img").tap();
    const touchDialog = touch.getByRole("dialog", { name: "Image preview" });
    await touchDialog.waitFor();
    await touchDialog.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    const touchBounds = await touchDialog.locator(".image-preview-viewport").boundingBox();
    const touchFitted = await touchDialog.getByRole("img").boundingBox();
    for (let i = 0; i < 2; i++) await touch.touchscreen.tap(touchBounds.x + touchBounds.width / 2, touchBounds.y + touchBounds.height / 2);
    assert.ok((await touchDialog.getByRole("img").boundingBox()).width > touchFitted.width, "double tap zooms from fit");
    for (let i = 0; i < 2; i++) await touch.touchscreen.tap(touchBounds.x + touchBounds.width / 2, touchBounds.y + touchBounds.height / 2);
    assert.ok(Math.abs((await touchDialog.getByRole("img").boundingBox()).width - touchFitted.width) < 1, "another double tap returns to fit");
    await touchDialog.getByRole("button", { name: "Close", exact: true }).tap();
    await touchDialog.waitFor({ state: "hidden" });
    const assertNativeReturn = async () => {
      assert.equal(await touch.evaluate(() => editor.view.hasFocus()), false,
        "closing an image viewer must not focus the native contenteditable and expose its node range");
      assert.equal(await touch.locator('.note-image-block[data-selected="true"]').count(), 1);
      assert.equal(await touch.getByRole("button", { name: "Image actions", exact: true }).isVisible(), true);
      assert.equal(await touch.evaluate(() => window.getSelection()?.isCollapsed ?? true), true);
    };
    await assertNativeReturn();
    await touch.getByRole("button", { name: "Image actions", exact: true }).tap();
    await touch.getByRole("menuitem", { name: "Open image full screen", exact: true }).tap();
    await touchDialog.waitFor();
    await touchDialog.getByRole("button", { name: "Close", exact: true }).tap();
    await touchDialog.waitFor({ state: "hidden" });
    await assertNativeReturn();
    await touch.getByText("Tap here afterwards", { exact: true }).tap();
    await touch.waitForFunction(() => editor.view.hasFocus() && editor.state.selection.empty);
    await touch.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("native previews accept every primary pointer in read-only notes and signal their portal lifetime", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.messages = [];
      window.installTestBridge({ native: function(message) { window.messages.push(message); } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => "editor" in window);
    for (const editable of [true, false]) for (const pointerType of ["pen", "mouse", "touch"]) {
      await page.evaluate(editable => {
        editor.setEditable(editable);
        editor.commands.setContent({ type: "doc", content: [{ type: "image", attrs: { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/>", width: 200, height: 100 } }] });
        window.messages = [];
      }, editable);
      const image = page.locator(".note-image-host");
      await image.waitFor();
      const pointer = async (type, x = 50, extra = {}) => image.dispatchEvent(type, { pointerId: 1, pointerType, isPrimary: true, button: 0, clientX: x, clientY: 50, ...extra });
      // A scroll cancellation and a drag that returns to its origin both break the double tap.
      for (const cancel of [true, false]) {
        await pointer("pointerdown");
        if (!cancel) await pointer("pointermove", 80);
        await pointer(cancel ? "pointercancel" : "pointerup");
        await pointer("pointerdown"); await pointer("pointerup");
        assert.equal(await page.getByRole("dialog", { name: "Image preview" }).count(), 0);
        await page.waitForTimeout(340);
      }
      await pointer("pointerdown"); await pointer("pointerup");
      await pointer("pointerdown"); await pointer("pointerup");
      const dialog = page.getByRole("dialog", { name: "Image preview" });
      await dialog.waitFor({ timeout: 3000 });
      assert.equal(await page.evaluate(() => messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), true);
      await dialog.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      // Lengthen the real exit animation: native chrome must stay hidden until removal.
      await page.addStyleTag({ content: '.image-preview-dialog[data-closed] { animation-duration: 500ms !important; }' });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await page.evaluate(() => !!document.querySelector(".image-preview-dialog") && messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), true);
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), false);
      await pointer("pointerdown"); await pointer("pointerup");
      await pointer("pointerdown"); await pointer("pointerup");
      await dialog.waitFor();
      await page.evaluate(() => editor.commands.setContent("<p>Image removed</p>"));
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), false);
    }
    // Separate node views may overlap during replacement. Removing one must
    // not expose native chrome while another preview still owns a portal.
    await page.evaluate(() => {
      editor.commands.setContent({ type: "doc", content: [1, 2].map(() => ({ type: "image", attrs: { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/>", width: 200, height: 100 } })) });
    });
    await page.locator(".note-image-host").nth(1).waitFor();
    for (const host of await page.locator(".note-image-host").all()) {
      for (let i = 0; i < 2; i++) for (const type of ["pointerdown", "pointerup"]) {
        await host.dispatchEvent(type, { pointerId: 1, pointerType: "pen", isPrimary: true, button: 0, clientX: 50, clientY: 50 });
      }
    }
    await page.waitForFunction(() => document.querySelectorAll(".image-preview-dialog").length === 2);
    await page.evaluate(() => editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild.nodeSize)));
    await page.waitForFunction(() => document.querySelectorAll(".image-preview-dialog").length === 1);
    assert.equal(await page.evaluate(() => messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), true);
    await page.evaluate(() => editor.commands.setContent("<p>No previews left</p>"));
    await page.waitForFunction(() => !document.querySelector(".image-preview-dialog"));
    assert.equal(await page.evaluate(() => messages.filter(m => m.event === "imagePreview").at(-1)?.payload.open), false);
  } finally { await browser?.close(); await server.close(); }
});

test("a drawing keeps its previous preview and shows progress until the replacement decodes", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: (command, args) => {
        if (command === "resolve_card_image") {
          if (args.fileId === "missing-file") return Promise.reject(new Error("Not downloaded"));
          if (args.fileId === "preview-broken") return Promise.resolve("data:image/png;base64,invalid");
          if (args.fileId.startsWith("preview-next")) return new Promise(resolve => { window.releasePreview = resolve; });
          return Promise.resolve(window.firstPreview);
        }
        return Promise.resolve(null);
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => "editor" in window);
    const sources = await page.evaluate(() => {
      const image = (color) => { const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 100; const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, 200, 100); return canvas.toDataURL(); };
      window.firstPreview = image("blue");
      const second = image("red");
      editor.commands.setContent({ type: "doc", content: [{ type: "image", attrs: { imageId: crypto.randomUUID(), fileId: "preview-first", width: 200, height: 100, drawing: { version: 1, sourceId: "source-first", previewId: "preview-first" } } }] });
      return [window.firstPreview, second];
    });
    // The outgoing crossfade copy can coexist with the live preview briefly.
    const preview = page.locator(".note-image-host img").first();
    await page.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
    await page.evaluate(() => { editor.commands.setNodeSelection(0); editor.commands.updateAttributes("image", { fileId: "preview-next", drawing: { version: 1, sourceId: "source-next", previewId: "preview-next" } }); });
    await page.getByRole("status").waitFor();
    assert.equal(await preview.getAttribute("src"), sources[0]);
    await page.waitForFunction(() => typeof window.releasePreview === "function");
    await page.evaluate(source => window.releasePreview(source), sources[1]);
    await page.getByRole("status").waitFor({ state: "hidden" });
    assert.equal(await preview.getAttribute("src"), sources[1]);
    await page.evaluate(() => editor.commands.updateAttributes("image", { fileId: "preview-broken", drawing: { version: 1, sourceId: "source-broken", previewId: "preview-broken" } }));
    await page.getByRole("button", { name: "Drawing (edit on iPad)", exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByRole("status").count(), 0, "Decode failures must stop progress and expose the fallback");
    await page.evaluate(() => {
      window.releasePreview = undefined;
      editor.commands.updateAttributes("image", { fileId: "preview-next-2", drawing: { version: 1, sourceId: "source-next-2", previewId: "preview-next-2" } });
    });
    await page.getByRole("status").waitFor({ timeout: 3000 });
    await page.waitForFunction(() => typeof window.releasePreview === "function");
    await page.evaluate(source => window.releasePreview(source), sources[1]);
    await page.waitForFunction(source => {
      const image = document.querySelector(".note-image-host img");
      return image?.getAttribute("src") === source && image.complete && image.naturalWidth > 0;
    }, sources[1]);
    await page.getByRole("status").waitFor({ state: "hidden" });
    assert.equal(await preview.getAttribute("src"), sources[1], "An earlier decode error must not hide progress for a newer revision");
    await page.evaluate(() => editor.commands.updateAttributes("image", { drawing: null, fileId: "preview-broken" }));
    await page.getByText("Image unavailable", { exact: true }).waitFor();
    assert.equal(await page.getByRole("status").count(), 0, "Ordinary broken images must retain their unavailable state");
    await page.evaluate(() => editor.commands.updateAttributes("image", { fileId: "missing-file", src: null }));
    await page.getByText("Image unavailable", { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await preview.count(), 0, "An unavailable ordinary image must not retain another image's preview");
  } finally { await browser?.close(); await server.close(); }
});
