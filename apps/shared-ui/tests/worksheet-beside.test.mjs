import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import * as Y from "yjs";
import { chromium } from "playwright";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

function noteState() {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "The same operation on both sides preserves an equation.");
  paragraph.insert(0, [text]);
  doc.getXmlFragment("default").insert(0, [paragraph]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return state;
}

function samplePdf() {
  const stream = "BT /F1 18 Tf 20 180 Td (Example equation) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  return `${pdf}xref\n0 6\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

test("opening, resizing and closing a note beside a worksheet preserves both edits", async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/repos/princhman/memnoter/releases/latest", route => route.fulfill({ status: 404, json: {} }));
    const setup = ({ state }) => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      localStorage.setItem("app-state", JSON.stringify({ modulePageByModule: { algebra: "questions" } }));
      const bank = {
        questions: { q: { title: "Solve 2x + 3 = 11", order: 0, revisionId: "r" } },
        revisions: { r: { questionId: "q", rootPartId: "p", parts: { p: { label: "", cropIds: [] } } } },
        attempts: { a: { title: "Algebra practice", questions: [{ questionId: "q", revisionId: "r" }] } },
        answers: {}, crops: {},
      };
      window.noteUpdates = [];
      window.answerUpdates = [];
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === "plugin:window|is_fullscreen") return false;
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "algebra", name: "Algebra" }, { id: "equations", name: "Equation rules" }];
        if (command === "question_bank_enabled") return true;
        if (command === "question_bank_get") return bank;
        if (command === "worksheet_answer_document_load") return { document: window.answerUpdates.at(-1) ?? [0, 0], expected: "base", plainText: null };
        if (command === "worksheet_answer_document_save") {
          window.answerUpdates.push(args.document);
          const key = JSON.stringify([args.attemptId, args.revisionId, args.leafPartId]);
          bank.answers[key] = { text: "Subtract 3, then divide by 2. x = 4." };
          return { bank, expected: "base" };
        }
        if (command === "get_content") return args.moduleId === "equations" ? {
          state, updates: window.noteUpdates, files: [{ id: "diagram", path: "/diagram.svg", file_type: "image/svg+xml" }],
        } : { state: [], updates: [], files: [] };
        if (command === "resolve_card_image") return "/diagram.svg";
        if (command === "list_documents") return [{ id: "proof-pdf", moduleId: "equations", moduleName: "Equation rules", name: "Example.pdf", size: 600, pageCount: 1, createdAt: 0, available: true }];
        if (command === "document_path") return "/example.pdf";
        if (command === "add_update") {
          assertNoteModule(args.moduleId);
          const update = { id: window.noteUpdates.length + 1, bytes: args.bytes };
          window.noteUpdates.push(update);
          return update;
        }
        if (command === "sync_status") return { enabled: false, account: null };
        return [];
      } } });
      function assertNoteModule(moduleId) {
        if (moduleId !== "equations") throw new Error("Wrong note persisted");
      }
    };
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})(${JSON.stringify({ state: noteState() })});`);
    await page.route("**/diagram.svg", route => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="seagreen"/></svg>',
    }));
    await page.route("**/example.pdf", route => route.fulfill({ contentType: "application/pdf", body: samplePdf() }));
    await page.goto(`http://localhost:${server.httpServer.address().port}/algebra`);
    await page.getByRole("button", { name: /Algebra practice/ }).click();
    const answer = page.locator(".worksheet-answer-input[contenteditable=true]");
    await answer.waitFor();
    const proof = process.env.PROOF_DIR;
    const pause = () => proof ? page.waitForTimeout(900) : Promise.resolve();
    await pause();
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox").fill("Open beside");
    await page.getByRole("option", { name: /Open beside/ }).click();
    await page.getByRole("dialog", { name: "Open beside" }).getByRole("button", { name: "Equation rules", exact: true }).click();
    const aside = page.getByRole("complementary", { name: "Worksheet side pane" });
    const note = aside.locator(".tiptap[contenteditable=true]");
    await note.waitFor();
    await pause();
    await answer.click();
    await page.keyboard.type("Subtract 3, then divide by 2. x = 4.", { delay: proof ? 50 : 0 });
    await pause();
    await note.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Check by substituting x back in.", { delay: proof ? 50 : 0 });
    await pause();
    await page.waitForFunction(() => window.answerUpdates.length && window.noteUpdates.length &&
      !Object.keys(localStorage).some(key => key.startsWith("worksheet-drafts:")));
    assert.equal(await page.getByRole("alert").filter({ hasText: /acknowledge|Couldn't save/ }).count(), 0);
    const separator = page.getByRole("separator", { name: "Resize side pane" });
    const before = await aside.boundingBox();
    const handle = await separator.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 65, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok((await aside.boundingBox()).width > before.width + 40);
    await pause();
    if (proof) {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(proof, "desktop-light.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.locator("html.dark").waitFor({ state: "attached" });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(proof, "desktop-dark.png") });
    }
    await aside.getByRole("button", { name: "Close side pane" }).click();
    await aside.waitFor({ state: "hidden" });
    assert.match(await answer.innerText(), /x = 4/);
    await pause();
    await page.getByRole("button", { name: "Open beside", exact: true }).click();
    await page.getByRole("button", { name: "Equation rules", exact: true }).click();
    await note.waitFor();
    assert.match(await note.innerText(), /Check by substituting/);
    const touch = await page.context().newCDPSession(page);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.setViewportSize({ width: 1180, height: 820 });
    assert.ok((await separator.boundingBox()).height > (await separator.boundingBox()).width);
    if (proof) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(proof, "ipad-landscape-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await page.locator("html:not(.dark)").waitFor({ state: "attached" });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(proof, "ipad-landscape-light.png") });
    }
    await page.setViewportSize({ width: 820, height: 1180 });
    const portrait = await separator.boundingBox();
    assert.ok(portrait.width > portrait.height);
    const start = { x: Math.round(portrait.x + portrait.width / 2), y: Math.round(portrait.y + portrait.height / 2) };
    const portraitHeight = (await aside.boundingBox()).height;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y - 50 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.ok((await aside.boundingBox()).height > portraitHeight + 30);
    const openBeside = page.getByRole("button", { name: "Open beside", exact: true });
    await openBeside.click();
    await page.getByRole("button", { name: /Example Equation rules/ }).click();
    await aside.locator(".textLayer").getByText("Example equation").waitFor();
    await openBeside.click();
    await page.getByRole("button", { name: "Browse images in Equation rules" }).click();
    await page.getByRole("button", { name: "Image 1" }).click();
    await aside.getByRole("img", { name: "Image 1" }).waitFor();
    await aside.getByRole("button", { name: "Close side pane" }).click();
    assert.match(await answer.innerText(), /x = 4/);
    await page.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
