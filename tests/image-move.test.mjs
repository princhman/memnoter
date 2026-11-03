import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

test("internal block and inline image drops retain assets, descriptions and masks with one-step undo/redo", async () => {
  const cacheDir = await mkdtemp(join(fileURLToPath(new URL("../node_modules/", import.meta.url)), ".memnoter-vite-"));
  const server = await createServer({ cacheDir, root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => "editor" in window);
    for (const type of ["image", "inlineImage"]) {
      await page.reload();
      await page.waitForFunction(() => "editor" in window);
      const result = await page.evaluate(async type => {
        try {
        const image = { type, attrs: { fileId: "retained-asset", imageId: "identity", alt: "Diagram", title: "Caption", masks: [{ id: "mask", shape: "rectangle", x: .1, y: .1, width: .3, height: .3 }] } };
        editor.commands.setContent({ type: "doc", content: [type === "image" ? image : { type: "paragraph", content: [image] }, { type: "paragraph", content: [{ type: "text", text: "Drop here" }] }] });
        await new Promise(resolve => setTimeout(resolve, 30));
        const before = editor.getJSON();
        const handle = document.querySelector(".note-image-drag");
        const target = document.querySelector(".tiptap > p:last-child").getBoundingClientRect();
        const transfer = new DataTransfer();
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        document.querySelector(".note-image-drag").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
        if (!editor.view.dragging) throw new Error("native dragstart did not capture the image slice");
        editor.view.dom.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: target.left + 50, clientY: target.top + target.height / 2 }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const after = editor.getJSON();
        editor.commands.undo();
        const undone = editor.getJSON();
        editor.commands.redo();
        return { before, after, undone, redone: editor.getJSON() };
        } catch (e) { throw new Error(type + ": " + e.stack); }
      }, type);
      assert.notDeepEqual(result.after, result.before, "drop moves the image");
      assert.deepEqual(result.undone, result.before);
      assert.deepEqual(result.redone, result.after);
      const images = node => [ ...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap(images) ];
      assert.deepEqual(images(result.after), images(result.before));
      assert.ok(result.after.content.findIndex(node => images(node).length) > 0, JSON.stringify(result.after));
    }
  } finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
