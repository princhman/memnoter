import { browserHarness } from "./support/browser.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

// Real pointer input in Tauri's browser engine: pressing on an image and
// dragging moves it, while a press without moving still selects it.
test("dragging block and inline images moves them with assets, descriptions and masks, in one undo step", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => "editor" in window);
    const src = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400; canvas.height = 200;
      canvas.getContext("2d").fillRect(0, 0, 400, 200);
      return canvas.toDataURL();
    });
    for (const type of ["image", "inlineImage"]) {
      await page.evaluate(({ type, src }) => {
        const image = { type, attrs: { src, fileId: "retained-asset", imageId: "identity", alt: "Diagram", title: "Caption", width: 200, height: 100, masks: [{ id: "mask", shape: "rectangle", x: .1, y: .1, width: .3, height: .3 }] } };
        editor.commands.setContent({ type: "doc", content: [
          type === "image" ? image : { type: "paragraph", content: [{ type: "text", text: "Before " }, image] },
          { type: "paragraph", content: [{ type: "text", text: "Middle" }] },
          { type: "paragraph", content: [{ type: "text", text: "Drop here" }] },
        ] });
      }, { type, src });
      const img = page.locator(".note-image-host img").first();
      await page.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
      const before = await page.evaluate(() => editor.getJSON());

      // A press without moving selects the image and shows its toolbar.
      await img.click();
      await page.getByRole("button", { name: "Image actions", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => editor.state.selection.node?.type.name), type);
      assert.deepEqual(await page.evaluate(() => editor.getJSON()), before);

      const box = await img.boundingBox();
      const target = await page.locator(".tiptap > p:last-child").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10, { steps: 3 });
      await page.mouse.move(target.x + target.width - 5, target.y + target.height / 2, { steps: 10 });
      assert.equal(await page.locator(".note-image-drop-indicator").isVisible(), true, "drop marker while moving");
      await page.mouse.up();

      const result = await page.evaluate(() => {
        const after = editor.getJSON();
        const selected = editor.state.selection.node?.type.name;
        editor.commands.undo();
        const undone = editor.getJSON();
        editor.commands.redo();
        return { after, selected, undone, redone: editor.getJSON() };
      });
      const images = node => [...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap(images)];
      assert.deepEqual(images(result.after), images(before), "same asset, description and masks");
      assert.equal(result.selected, type, "moved image stays selected");
      const lastWithImage = result.after.content.findLastIndex(node => images(node).length);
      assert.ok(lastWithImage >= 2, `moved below the other paragraphs: ${JSON.stringify(result.after)}`);
      if (type === "inlineImage") assert.equal(result.after.content[2].content[0].text, "Drop here");
      assert.deepEqual(result.undone, before, "one undo step restores the original");
      assert.deepEqual(result.redone, result.after);
      assert.equal(await page.locator(".note-image-drop-indicator").count(), 0);
      assert.equal(await page.locator("[data-moving], .is-moving-image").count(), 0);
      assert.equal(await img.evaluate(el => getComputedStyle(el).opacity), "1");
      if (type === "inlineImage") {
        // WebKit's native caret would span the image's whole line; a drawn
        // text-height caret replaces it while typing beside the image.
        await page.evaluate(() => { editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before " }, { type: "inlineImage", attrs: { src: document.querySelector(".note-image-host img").src, width: 200, height: 100 } }] }] }); editor.commands.focus("end"); });
        await page.keyboard.type("heh");
        const caret = page.locator(".italic-caret.is-upright");
        await caret.waitFor({ state: "attached" });
        const height = await caret.evaluate(element => element.getBoundingClientRect().height);
        assert.ok(height > 0 && height < 40, `text-height caret beside an inline image: ${height}`);
        assert.equal(await page.evaluate(() => getComputedStyle(editor.view.dom).caretColor), "rgba(0, 0, 0, 0)");
      }
    }
    // Destroying the editor mid-drag must not leave the marker or listeners.
    await page.evaluate(({ src }) => editor.commands.setContent({ type: "doc", content: [
      { type: "image", attrs: { src, width: 200, height: 100 } }, { type: "paragraph", content: [{ type: "text", text: "Below" }] },
    ] }), { src });
    const img = page.locator(".note-image-host img").first();
    await page.waitForFunction(() => document.querySelector(".note-image-host img")?.naturalWidth > 0);
    assert.equal(await img.evaluate(el => getComputedStyle(el.closest(".note-image-host")).touchAction), "none", "touch drags move the image instead of scrolling");
    const box = await img.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 160, { steps: 5 });
    assert.equal(await page.locator(".note-image-drop-indicator").count(), 1, "drag in progress");
    await page.evaluate(() => editor.destroy());
    await page.waitForFunction(() => !document.querySelector(".note-image-drop-indicator") && !document.documentElement.classList.contains("is-moving-image"));
    await page.mouse.up();
  } finally { await browser?.close(); await server.close(); }
});
