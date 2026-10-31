// Caret movement around inline and block math, in a real WebKit (the engine
// behind Tauri on macOS). Rendered formulas hide their source, so native
// movement skips or sticks on them unless the math extensions step over it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
let server, browser, page;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  browser = await webkit.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  const { port } = server.httpServer.address();
  await page.goto(`http://localhost:${port}/tests/browser/editor.html`);
  await page.waitForFunction(() => "editor" in window);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const text = (value) => ({ type: "text", text: value });
const p = (...content) => ({ type: "paragraph", content });
const h1 = (value) => ({ type: "heading", attrs: { level: 1 }, content: [text(value)] });
const math = (tex) => ({ type: "inlineMath", content: [text(tex)] });
const block = (tex) => ({ type: "mathBlock", content: [text(tex)] });
const KEYS = { L: "ArrowLeft", R: "ArrowRight", U: "ArrowUp", D: "ArrowDown" };

// Presses each key and returns where the caret is before and after each one,
// as "<key><position><first letter of the block it is in>", e.g. "D8m".
async function walk(content, start, keys) {
  await page.evaluate(({ content, start }) => {
    editor.commands.setContent({ type: "doc", content });
    editor.commands.focus();
    editor.commands.setTextSelection(start);
  }, { content, start });
  const caret = () =>
    page.evaluate(() => {
      const { head, $head } = editor.state.selection;
      return `${head}${$head.parent.type.name[0]}`;
    });
  const steps = [await caret()];
  for (const key of keys) {
    await page.keyboard.press(KEYS[key]);
    await page.waitForTimeout(20);
    steps.push(key + (await caret()));
  }
  return steps.join(" ");
}

test("left and right step through an inline formula one character at a time", async () => {
  assert.equal(
    await walk([p(text("ab "), math("x^2"), text(" cd"))], 1, "RRRRRRRRRRLLLLLLLLLL"),
    "1p R2p R3p R4p R5i R6i R7i R8i R9p R10p R11p " +
      "L10p L9p L8i L7i L6i L5i L4p L3p L2p L1p",
  );
});

test("right reaches the end of a line that ends in a formula, then down and up", async () => {
  assert.equal(
    await walk([p(text("ab "), math("x^2")), p(text("next"))], 1, "RRRRRRRRDU"),
    "1p R2p R3p R4p R5i R6i R7i R8i R9p D15p U9p",
  );
});

test("up and down cross a line with an inline formula", async () => {
  assert.equal(
    await walk(
      [p(text("line one here")), p(text("ab "), math("x^2"), text(" cd")), p(text("line three"))],
      3,
      "DDDUUU",
    ),
    "3p D17p D31p D39p U17p U3p U1p",
  );
});

test("up and down stop beside a formula that is alone on its line", async () => {
  assert.equal(
    await walk(
      [p(text("line one here")), p(math("x^2+y^2")), p(text("line three"))],
      3,
      "DDDUUU",
    ),
    "3p D16p D27p D37p U25p U9p U1p",
  );
});

test("down and up wrap through a formula that spans two lines", async () => {
  const long = String.raw`AA7B_{16} = 10*16^3+10*16^2+7*16^1+11*16 = 43643_{10}`;
  const steps = (
    await walk([p(text("hexadecimal system - "), math(long), text(" (0x)")), p(text("next line"))], 3, "DDUU")
  ).split(" ");
  assert.notEqual(steps[1], "D3p", "down got stuck on the first line");
  assert.match(steps[2], /^D9\dp$/, "down did not reach the next paragraph");
  assert.notEqual(steps[3], steps[2].replace("D", "U"), "up got stuck");
});

test("up and down enter and leave a math block", async () => {
  assert.equal(
    await walk([p(text("above")), block("x^2"), p(text("below"))], 3, "DDDUUU"),
    "3p D8m D14p D18p U11m U5p U1p",
  );
});

test("left and right enter and leave a math block", async () => {
  assert.equal(
    await walk([p(text("above")), block("x^2"), p(text("below"))], 6, "RRRRRRRLLLLLLL"),
    "6p R8m R9m R10m R11m R13p R14p R15p " +
      "L14p L13p L11m L10m L9m L8m L6p",
  );
});

test("a math block right under a heading", async () => {
  assert.equal(
    await walk([h1("Title"), block("x^2"), p(text("below"))], 3, "DDDUUU"),
    "3h D8m D14p D18p U11m U4h U1h",
  );
});

test("two math blocks in a row", async () => {
  assert.equal(
    await walk([p(text("above")), block("a"), block("b"), p(text("below"))], 3, "DDDDUUUU"),
    "3p D8m D11m D15p D19p U12m U9m U3p U1p",
  );
});
