import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("desktop captions save with their image and renumber when it moves chapters", async () => {
  const doc = new Y.Doc();
  const block = (name, value, attrs = {}) => {
    const node = new Y.XmlElement(name);
    for (const [key, attr] of Object.entries(attrs)) node.setAttribute(key, attr);
    if (value) {
      const text = new Y.XmlText();
      text.insert(0, value);
      node.insert(0, [text]);
    }
    return node;
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="104"><rect width="320" height="104" rx="8" fill="#ebe7ff"/><path d="M34 78h252M34 78V20m0 48 50-18 40 7 50-28 55 11 57-18" stroke="#5842aa" stroke-width="3" fill="none"/></svg>';
  doc.getXmlFragment("default").insert(0, [
    block("heading", "Baseline", { level: 1 }),
    block("image", null, { src: "data:image/svg+xml," + encodeURIComponent(svg), width: 320, height: 104 }),
    block("paragraph", "Initial measurements"),
    block("heading", "Results", { level: 1 }),
    block("paragraph", "The next set of measurements"),
  ]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();

  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(state => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        const updates = JSON.parse(localStorage.getItem("caption-updates") || "[]");
        if (command === "modules") return [{ id: "lab", name: "Lab notes", heading_numbering: true }];
        if (command === "get_content") return { state, updates, files: [] };
        if (command === "add_update") {
          const saved = { id: updates.length + 1, bytes: args.bytes };
          localStorage.setItem("caption-updates", JSON.stringify([...updates, saved]));
          return saved;
        }
        if (command.startsWith("plugin:")) return false;
        return [];
      } } });
    }, state);
    const url = `http://localhost:${server.httpServer.address().port}/lab`;
    await page.goto(url);
    const editor = page.locator(".tiptap[contenteditable=true]");
    const image = editor.locator(".note-image");
    await page.waitForFunction(() => document.querySelector(".note-image")?.naturalWidth > 0);
    const pauseForProof = async () => {
      if (process.env.PROOF_DIR) await page.waitForTimeout(1000);
    };
    const actions = page.getByRole("button", { name: "Image actions" });
    const addCaption = page.getByRole("menuitem", { name: "Add caption" });
    assert.equal(await actions.count(), 0);
    const belowImage = editor.getByText("Initial measurements", { exact: true });
    const beforeSelection = await belowImage.boundingBox();
    await pauseForProof();
    await image.click();
    await actions.waitFor();
    // Selecting the image no longer adds a caption row below it.
    assert.equal((await belowImage.boundingBox()).y, beforeSelection.y);
    await pauseForProof();
    await actions.click();
    await addCaption.click();
    const input = page.getByRole("textbox", { name: "Image caption" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Image caption");
    await input.pressSequentially("Measured signal", { delay: process.env.PROOF_DIR ? 85 : 0 });
    await page.keyboard.press("Enter");
    const caption = number => page.getByRole("button", { name: `Figure ${number}: Measured signal`, exact: true });
    await caption("1.1").waitFor();
    await pauseForProof();

    const picture = await image.boundingBox();
    const destination = await editor.getByText("The next set of measurements").boundingBox();
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("caption-updates") || "[]").length);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("caption-updates") || "[]").length > 0);
    const beforeMove = await stored();
    await page.mouse.move(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await page.mouse.down();
    await page.mouse.move(picture.x + picture.width / 2 + 12, picture.y + picture.height / 2 + 12, { steps: 4 });
    await page.mouse.move(destination.x + destination.width - 6, destination.y + destination.height - 2, { steps: 22 });
    await page.mouse.up();
    await caption("2.1").waitFor();
    await pauseForProof();
    await page.waitForFunction(before => JSON.parse(localStorage.getItem("caption-updates") || "[]").length > before, beforeMove);
    await page.reload();
    await caption("2.1").waitFor();

    // The caption can sit left, centre (default) or right under the image.
    const captionRow = page.locator(".note-image-caption").first();
    assert.equal(await captionRow.evaluate(el => getComputedStyle(el).textAlign), "center");
    await image.click();
    await page.getByRole("button", { name: "Image actions" }).click();
    await page.getByRole("menuitem", { name: "Caption alignment" }).hover();
    await page.getByRole("menuitem", { name: "Caption alignment" }).press("ArrowRight");
    const updatesBefore = await stored();
    await page.getByRole("menuitemradio", { name: "Align right" }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".note-image-caption")).textAlign === "right");
    await page.waitForFunction(before => JSON.parse(localStorage.getItem("caption-updates") || "[]").length > before, updatesBefore);
    await page.reload();
    await caption("2.1").waitFor();
    assert.equal(await page.locator(".note-image-caption").first().evaluate(el => getComputedStyle(el).textAlign), "right");
  } finally {
    await server.close();
  }
});
