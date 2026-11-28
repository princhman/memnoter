import { browserHarness } from "./support/browser.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

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
      // Keep the block drop inside the lower half when WebKit rounds pointer coordinates.
      const dropY = target.y + target.height * (type === "image" ? 0.75 : 0.5);
      await page.mouse.move(target.x + target.width - 5, dropY, { steps: 10 });
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

test("pasting an image at the end of a note or quote leaves a typing line only where needed", async () => {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment("default");
  const paragraph = text => {
    const block = new Y.XmlElement("paragraph");
    const content = new Y.XmlText();
    content.insert(0, text);
    block.insert(0, [content]);
    return block;
  };
  const quote = new Y.XmlElement("blockquote");
  quote.insert(0, [paragraph("A line inside a quote.")]);
  blocks.insert(0, [paragraph("Paste before the quote."), quote, paragraph("A line at the end of the note.")]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();

  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(state => {
      const images = {};
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Image paste" }];
        if (command === "get_content") return { state, updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        if (command === "save_file") {
          const id = String(Object.keys(images).length + 1);
          images[id] = args.bytes;
          return { id, path: "data:image/png;base64," + btoa(String.fromCharCode(...args.bytes)), file_type: "image/png" };
        }
        if (command === "read_file") return { bytes: images[args.fileId], file_type: "image/png" };
        return [];
      } } });
    }, state);
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
    const editor = page.locator(".tiptap[contenteditable=true]");
    const realClipboard = process.env.BROWSER === "chromium";
    if (realClipboard) await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const pasteImage = async line => {
      const paragraph = editor.getByText(line, { exact: true });
      const box = await paragraph.boundingBox();
      await paragraph.click({ position: { x: box.width - 8, y: 8 } });
      await page.waitForFunction(line => {
        const selection = document.querySelector(".tiptap").editor.state.selection;
        return selection.$from.parent.textContent === line && selection.$from.parentOffset === line.length;
      }, line);
      await page.evaluate(async realClipboard => {
        const canvas = document.createElement("canvas");
        canvas.width = 260;
        canvas.height = 96;
        const context = canvas.getContext("2d");
        context.fillStyle = "#eee8ff";
        context.fillRect(0, 0, 260, 96);
        context.fillStyle = "#322577";
        context.font = "20px sans-serif";
        context.fillText("Clipboard image", 48, 55);
        const [, encoded] = canvas.toDataURL().split(",");
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        if (realClipboard) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
          return;
        }
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([bytes], "diagram.png", { type: "image/png" }));
        document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      }, realClipboard);
      if (realClipboard) await page.keyboard.press("Control+v");
    };
    await pasteImage("A line at the end of the note.");
    const lastLine = editor.locator(":scope > .node-image + p:last-child");
    await lastLine.waitFor();
    await page.waitForFunction(() => document.querySelector(".tiptap .node-image img")?.naturalWidth > 0);
    assert.equal(await lastLine.textContent(), "");
    if (process.env.PROOF_DIR) await page.waitForTimeout(900);
    await page.keyboard.type("Keep typing below the image.", { delay: process.env.PROOF_DIR ? 75 : 0 });
    assert.equal(await lastLine.textContent(), "Keep typing below the image.");
    if (process.env.PROOF_DIR) await page.waitForTimeout(1100);

    await pasteImage("A line inside a quote.");
    const lastQuoteLine = editor.locator("blockquote > .node-image + p:last-child");
    await lastQuoteLine.waitFor();
    await page.keyboard.type("Still inside the quote.", { delay: process.env.PROOF_DIR ? 75 : 0 });
    assert.equal(await lastQuoteLine.textContent(), "Still inside the quote.");
    if (process.env.PROOF_DIR) await page.waitForTimeout(1100);

    await pasteImage("Paste before the quote.");
    await editor.locator(":scope > .node-image + blockquote").waitFor();
    if (process.env.PROOF_DIR) await page.waitForTimeout(1100);
  } finally {
    await server.close();
  }
});
