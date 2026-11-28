import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import * as Y from "yjs";
import { browserHarness } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

function noteState({ table = false } = {}) {
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
  const blocks = [
    block("heading", "Baseline", { level: 1 }),
    block("image", null, { src: "data:image/svg+xml," + encodeURIComponent(svg), width: 320, height: 104 }),
    block("paragraph", "Initial measurements"),
    block("heading", "Results", { level: 1 }),
    block("paragraph", "The next set of measurements"),
  ];
  if (table) {
    const row = block("tableRow");
    row.insert(0, ["Left cell text", "Right cell text"].map(label => {
      const cell = block("tableCell");
      cell.insert(0, [block("paragraph", label)]);
      return cell;
    }));
    const grid = block("table");
    grid.insert(0, [row]);
    blocks.push(grid);
  }
  doc.getXmlFragment("default").insert(0, blocks);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return state;
}

async function openNote(t, options = {}, content = {}) {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  t.after(() => server.close());
  await server.listen();
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, ...options });
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
  }, noteState(content));
  const url = `http://localhost:${server.httpServer.address().port}/lab`;
  await page.goto(url);
  const editor = page.locator(".tiptap[contenteditable=true]");
  const image = editor.locator(".note-image");
  await page.waitForFunction(() => document.querySelector(".note-image")?.naturalWidth > 0);
  return { page, editor, image };
}

test("desktop captions save with their image and renumber when it moves chapters", async t => {
  const { page, editor, image } = await openNote(t);
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
  const captionText = "Measured signal from the detector after the second calibration";
  await input.pressSequentially(captionText, { delay: process.env.PROOF_DIR ? 85 : 0 });
  await page.keyboard.press("Enter");
  const caption = number => page.getByRole("button", { name: `Figure ${number}: ${captionText}`, exact: true });
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
  const captionButton = caption("2.1");
  for (const alignment of ["left", "right"]) {
    await image.click();
    await actions.click();
    const submenu = page.getByRole("menuitem", { name: "Caption alignment" });
    await submenu.hover();
    await submenu.press("ArrowRight");
    const updatesBefore = await stored();
    await page.getByRole("menuitemradio", { name: `Align ${alignment}` }).click();
    await page.waitForFunction(before => JSON.parse(localStorage.getItem("caption-updates") || "[]").length > before, updatesBefore);
    await page.reload();
    const layout = await captionButton.evaluate(button => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const fragments = Array.from(range.getClientRects());
      const last = fragments.at(-1);
      const lastLine = fragments.filter(fragment => fragment.top === last.top);
      const left = Math.min(...lastLine.map(fragment => fragment.left));
      const right = Math.max(...lastLine.map(fragment => fragment.right));
      const bounds = button.getBoundingClientRect();
      return {
        alignment: getComputedStyle(button).textAlign,
        wraps: last.top > fragments[0].top,
        left: left - bounds.left,
        rightAlignedLeft: bounds.right - bounds.left - (right - left),
      };
    });
    assert.ok(layout.wraps, "the caption spans multiple lines");
    assert.equal(layout.alignment, alignment);
    assert.ok(layout.rightAlignedLeft > 4, "the final line has room to shift");
    const expectedLeft = alignment === "left" ? 0 : layout.rightAlignedLeft;
    assert.ok(Math.abs(layout.left - expectedLeft) < 1, `the last line is flush ${alignment}`);

    await captionButton.click();
    assert.equal(await input.evaluate(el => getComputedStyle(el).textAlign), alignment);
    await input.press("Escape");
  }
});

test("an unselected image can be dragged from a corner to the marked block boundary", async t => {
  const proof = process.env.PROOF_DIR;
  const { page, editor, image } = await openNote(t, { colorScheme: "light" });
  const marker = page.locator(".note-image-drop-indicator");
  const results = editor.getByRole("heading", { name: /Results/ });
  const paragraph = editor.getByText("The next set of measurements", { exact: true });
  assert.equal(await page.getByRole("button", { name: "Image actions" }).count(), 0);

  const picture = await image.boundingBox();
  const preceding = await results.boundingBox();
  const following = await paragraph.boundingBox();
  const x = picture.x + 4;
  const y = picture.y + 4;
  await page.mouse.move(x, y);
  if (proof) await page.waitForTimeout(650);
  await page.mouse.down();
  await page.mouse.move(x + 16, y + 12, { steps: 5 });
  if (proof) await page.waitForTimeout(600);
  await page.mouse.move(following.x + following.width - 10, following.y + 4, { steps: 26 });
  await marker.waitFor();
  const line = await marker.boundingBox();
  assert.ok(Math.abs(line.x - following.x) < 1 && Math.abs(line.width - following.width) < 1, "line spans the text column");
  assert.ok(line.height >= 3 && line.y + line.height / 2 >= preceding.y + preceding.height &&
    line.y + line.height / 2 <= following.y, "line marks the gap above the paragraph");

  if (proof) {
    await page.screenshot({ path: join(proof, "image-drop-light.png") });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: join(proof, "image-drop-dark.png") });
    await page.waitForTimeout(700);
  }
  await page.mouse.up();
  await page.waitForFunction(() => {
    const block = document.querySelector(".tiptap > .node-image");
    return block?.previousElementSibling?.textContent.includes("Results") &&
      block?.nextElementSibling?.textContent === "The next set of measurements";
  });
  assert.equal(await marker.count(), 0);
  if (proof) {
    await page.waitForTimeout(1000);
    const video = page.video();
    await page.close();
    await video.saveAs(join(proof, "image-drop.webm"));
  }
});

async function dragImageTo(page, image, x, y) {
  const picture = await image.boundingBox();
  await page.mouse.move(picture.x + 20, picture.y + 20);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
}

test("a block image drop line fits the destination table cell", async t => {
  const { page, editor, image } = await openNote(t, {}, { table: true });
  const cell = editor.getByRole("cell", { name: "Right cell text" });
  const bounds = await cell.boundingBox();
  const paragraph = await cell.locator("p").boundingBox();
  await dragImageTo(page, image, paragraph.x + 12, paragraph.y + paragraph.height / 2);
  const line = await page.locator(".note-image-drop-indicator").boundingBox();
  await page.mouse.up();

  assert.ok(line && line.x >= bounds.x - 1 &&
    line.x + line.width <= bounds.x + bounds.width + 1, "line stays inside the destination cell");
  await cell.locator(".note-image").waitFor();
  assert.equal(await editor.locator(".note-image").count(), 1);
});

test("dropping just below a folded heading leaves its section folded", async t => {
  const { page, editor, image } = await openNote(t);
  const results = editor.getByRole("heading", { name: /Results/ });
  await results.hover();
  await results.getByRole("button", { name: "Fold section", exact: true }).click();
  const hidden = editor.getByText("The next set of measurements", { exact: true });
  assert.equal(await hidden.isVisible(), false);

  const heading = await results.boundingBox();
  await dragImageTo(page, image, heading.x + 30, heading.y + heading.height - 2);
  const markerVisible = await page.locator(".note-image-drop-indicator").isVisible();
  await page.mouse.up();

  assert.equal(markerVisible, false, "the folded section accepts no drop at its lower edge");
  assert.equal(await results.getByRole("button", { name: "Unfold section", exact: true }).count(), 1);
  assert.equal(await hidden.isVisible(), false);
  assert.equal(await editor.locator(".node-image + p").textContent(), "Initial measurements");
});
