import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { webkit } from "playwright";

// Pixel evidence at the actual rendering boundary: DOM/CSS assertions alone
// cannot detect WebKit's native newline and replaced-element selection paint.
test("WebKit selection hugs text and keeps image actions exclusive", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cacheDir = await mkdtemp(join(root, "node_modules/.selection-vite-"));
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  const artifacts = process.env.SELECTION_ARTIFACTS ?? "/tmp/memnoter-selection";
  await mkdir(artifacts, { recursive: true });
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 960, height: 1500 } });
    page.on("pageerror", console.error);
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(() => document.fonts.ready);
    for (const dark of [false, true]) {
      await page.evaluate(dark => {
        document.documentElement.classList.toggle("dark", dark);
        const text = (type, text) => ({ type, ...(type === "heading" ? { attrs: { level: 2 } } : {}), content: [{ type: "text", text }] });
        const canvas = document.createElement("canvas"); canvas.width = 220; canvas.height = 80;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "#888"; ctx.fillRect(0, 0, 220, 80);
        const img = { type: "image", attrs: { src: canvas.toDataURL(), width: 220, height: 80 } };
        editor.commands.setContent({ type: "doc", content: [text("paragraph", "heh"), text("heading", "hello 2"), img, text("paragraph", "hello, how are you doing?"), text("heading", "This is pretty cool"), { type: "paragraph" }, { type: "paragraph" }, img, text("paragraph", "AV office affinity tail"), { type: "paragraph", content: [{ type: "text", text: "Formula " }, { type: "inlineMath", content: [{ type: "text", text: "x^2" }] }, { type: "text", text: " end" }] }, text("mathBlock", "x^2 + y^2"), text("paragraph", "Q :: A"), text("codeBlock", "const value = 42"), { type: "paragraph", content: [{ type: "text", text: "hard first" }, { type: "hardBreak" }, { type: "text", text: "hard second" }] }, text("paragraph", "last line ending here")] });
        editor.commands.focus("start");
      }, dark);
      await page.waitForFunction(() => [...document.images].every(img => img.complete));
      await page.waitForTimeout(1700);
      const prefix = `${artifacts}/${dark ? "dark" : "light"}`;
      // Baseline captures also let pixel assertions compare with the real
      // background of code, math and chips rather than guessing theme RGB.
      const baseline = await page.screenshot({ path: `${prefix}-baseline.png` });
      const widths = await page.evaluate(() => [...editor.view.dom.querySelectorAll("p,h2")].map(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; }));
      for (const action of ["select-all", "drag", "shift-click", "shift-down", "mid-line"]) {
        await page.evaluate(() => editor.commands.focus("start"));
        const first = await page.locator(".tiptap > p").first().boundingBox();
        const target = await page.locator(".tiptap > h2").last().boundingBox();
        if (action === "select-all") await page.keyboard.press("Meta+a");
        if (action === "drag") {
          await page.mouse.move(first.x + 1, first.y + first.height / 2); await page.mouse.down();
          await page.mouse.move(target.x + 120, target.y + target.height / 2, { steps: 20 }); await page.mouse.up();
        }
        if (action === "shift-click") {
          await page.mouse.click(first.x + 1, first.y + first.height / 2);
          await page.keyboard.down("Shift"); await page.mouse.click(target.x + 120, target.y + target.height / 2); await page.keyboard.up("Shift");
        }
        if (action === "shift-down") {
          await page.locator(".note-image").first().click(); await page.keyboard.press("Shift+ArrowDown");
        }
        if (action === "mid-line") await page.evaluate(() => {
          let end; editor.state.doc.descendants((node, pos) => { if (node.textContent === "AV office affinity tail" && node.isTextblock) end = pos + 10; });
          editor.commands.setTextSelection({ from: 2, to: end });
        });
        await page.waitForTimeout(80);
        assert.equal(await page.evaluate(() => editor.state.selection.empty), false, action);
        await page.screenshot({ path: `${prefix}-${action}.png` });
        const png = await page.screenshot({ style: '[aria-label="Text formatting"], [aria-label="Text formatting"] * { visibility: hidden !important; }' });
        const evidence = await page.evaluate(async ({ before, after }) => {
          const decode = async base64 => { const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height); };
          const a = await decode(before), b = await decode(after);
          const pixel = (data, x, y) => Array.from(data.data.slice((Math.floor(y) * data.width + Math.floor(x)) * 4, (Math.floor(y) * data.width + Math.floor(x)) * 4 + 3));
          const equal = (x, y) => {
            const offset = (Math.floor(y) * a.width + Math.floor(x)) * 4;
            return a.data[offset] === b.data[offset] && a.data[offset + 1] === b.data[offset + 1] && a.data[offset + 2] === b.data[offset + 2];
          };
          const { from, to } = editor.state.selection;
          const column = editor.view.dom.getBoundingClientRect();
          const reference = document.createElement("span");
          reference.style.background = "color-mix(in oklch, var(--primary) 80%, transparent)";
          document.body.append(reference);
          const originalColour = getComputedStyle(reference).backgroundColor;
          reference.remove();
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d");
          const expected = (x, y) => {
            const rgb = pixel(a, x, y);
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = `rgb(${rgb.join(",")})`; ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = originalColour; ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
          };
          const lines = []; let spills = 0, invisible = 0, gaps = 0, wrongColour = 0, emptyPaint = 0, breakPaint = 0;
          editor.state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === "hardBreak") {
              const r = editor.view.nodeDOM(pos).getBoundingClientRect();
              for (let y = Math.ceil(r.top + 1); y < r.bottom - 1; y++) for (let x = Math.ceil(r.left + 1); x < column.right - 4; x++) if (!equal(x, y)) breakPaint++;
            }
            if (!node.isText || !node.text.trim()) return;
            const start = Math.max(from, pos), end = Math.min(to, pos + node.nodeSize);
            if (start >= end) return;
            const s = editor.view.domAtPos(start), e = editor.view.domAtPos(end);
            const range = document.createRange(); range.setStart(s.node, s.offset); range.setEnd(e.node, e.offset);
            for (const r of range.getClientRects()) {
              if (r.width < 3 || !r.height) continue;
              const y = Math.ceil(r.top + 1);
              // Only test the right of a line after ALL its text, including
              // unselected suffixes and inline widgets, to avoid counting ink.
              let parent = s.node.nodeType === 3 ? s.node.parentElement : s.node;
              parent = parent.closest("p,h1,h2,h3,pre,.math-block-source") ?? parent;
              const full = document.createRange(); full.selectNodeContents(parent);
              const right = Math.max(...[...full.getClientRects()].filter(rect => rect.top <= y && rect.bottom > y).map(rect => rect.right), r.right);
              let spill = 0;
              for (let row = Math.ceil(r.top); row < r.bottom; row++) for (let x = Math.ceil(right + 1); x < column.right - 4; x++) if (!equal(x, row)) spill++;
              if (spill) spills += spill;
              // Top of the font box is background, outside glyph ink.
              let lit = 0, original = 0;
              for (let x = Math.ceil(r.left + 1); x < r.right - 1; x++) {
                if (!equal(x, y)) lit++;
                const actual = pixel(b, x, y), wanted = expected(x, y);
                if (actual.every((channel, i) => Math.abs(channel - wanted[i]) <= 1)) original++;
              }
              if (!original) wrongColour++;
              if (!lit) invisible++;
              lines.push({ text: node.text, right, y, spill, lit, sample: pixel(b, column.right - 10, y), baseline: pixel(a, column.right - 10, y) });
            }
          });
          const blocks = [...editor.view.dom.children].map(el => el.getBoundingClientRect()).filter(r => r.height);
          for (let i = 1; i < blocks.length; i++) if (blocks[i].top > blocks[i - 1].bottom + 2) {
            const y = Math.floor((blocks[i].top + blocks[i - 1].bottom) / 2);
            for (let x = column.left + 8; x < column.right - 8; x++) if (!equal(x, y)) gaps++;
          }
          for (const empty of editor.view.dom.querySelectorAll("p")) {
            if (empty.textContent) continue;
            const r = empty.getBoundingClientRect();
            for (let y = Math.ceil(r.top + 1); y < r.bottom - 1; y++) for (let x = Math.ceil(r.left + 1); x < r.right - 1; x++) if (!equal(x, y)) emptyPaint++;
          }
          const imagePixels = [...editor.view.dom.querySelectorAll(".note-image")].map(img => {
            const r = img.getBoundingClientRect();
            return equal(r.left + r.width / 2, r.top + r.height / 2);
          });
          const math = editor.view.dom.querySelector(".math-block-widget").getBoundingClientRect();
          const mathSpill = !equal(column.right - 12, math.top + math.height / 2);
          const mathBase = editor.view.dom.querySelector(".math-block-widget .katex-base").getBoundingClientRect();
          let mathLit = 0;
          for (let y = Math.ceil(mathBase.top); y < mathBase.bottom; y++) for (let x = Math.ceil(mathBase.left); x < mathBase.right; x++) if (!equal(x, y)) mathLit++;
          return { lines, spills, invisible, gaps, imagePixels, mathSpill, mathLit, wrongColour, emptyPaint, breakPaint };
        }, { before: baseline.toString("base64"), after: png.toString("base64") });
        console.log(dark ? "dark" : "light", action, JSON.stringify(evidence));
        if (action === "select-all") assert.ok(evidence.mathLit > 0, "rendered math has visible selection feedback");
        assert.equal(evidence.wrongColour, 0, "selected glyph boxes retain the original 80% OKLCH colour");
        assert.equal(evidence.breakPaint, 0, "selected hard line breaks stay background");
        assert.equal(evidence.emptyPaint, 0, "selected empty paragraphs stay background");
        assert.equal(evidence.mathSpill, false, "rendered math does not fill its block width");
        assert.ok(evidence.imagePixels.every(Boolean), "no native image selection wash");
        assert.equal(evidence.spills, 0, "selected text must not paint to column edge");
        assert.equal(evidence.invisible, 0, "selected text must have visible highlight");
        assert.equal(evidence.gaps, 0, "block gaps must stay unpainted");
        assert.ok(evidence.lines.length, "measured selected nonempty text lines");
        if (["select-all", "mid-line"].includes(action)) {
          const afterWidths = await page.evaluate(() => [...editor.view.dom.querySelectorAll("p,h2")].map(el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; }));
          widths.forEach((w, i) => assert.ok(Math.abs(w - afterWidths[i]) < .1, "selection does not reshape text"));
        }
        assert.equal(await page.locator(".note-image-toolbar").isVisible(), false, "range does not open image actions");
        const containsImage = await page.evaluate(() => {
          let found = false; const { from, to } = editor.state.selection;
          editor.state.doc.nodesBetween(from, to, node => { if (["image", "inlineImage"].includes(node.type.name)) found = true; }); return found;
        });
        assert.equal(await page.getByRole("button", { name: "Bold", exact: true }).isVisible(), !containsImage, "text menu only for ordinary text ranges");
      }
      await page.locator(".note-image").first().click();
      await page.locator(".note-image-toolbar").waitFor();
      assert.equal(await page.getByRole("button", { name: "Bold", exact: true }).isVisible(), false);
      const outlines = await page.locator(".note-image-block").first().evaluate(el => [el.parentElement, el, ...el.querySelectorAll("*")].filter(el => getComputedStyle(el).outlineStyle !== "none" && parseFloat(getComputedStyle(el).outlineWidth) > 0).length);
      assert.equal(outlines, 1, "one image outline");
    }
    // Selection endpoints inside math expose its editable source, which must
    // use the same highlight and keep the document untouched.
    for (const type of ["inlineMath", "mathBlock"]) {
      const result = await page.evaluate(type => {
        let start; editor.state.doc.descendants((node, pos) => { if (node.type.name === type) start = pos + 1; });
        const before = JSON.stringify(editor.getJSON());
        editor.commands.setTextSelection({ from: start, to: start + 2 });
        const dom = editor.view.domAtPos(start + 1).node.parentElement;
        return { highlighted: !!dom.closest(".text-range-selected"), unchanged: before === JSON.stringify(editor.getJSON()) };
      }, type);
      assert.deepEqual(result, { highlighted: true, unchanged: true });
      await page.screenshot({ path: `${artifacts}/dark-${type}-source.png`, style: '[aria-label="Text formatting"], [aria-label="Text formatting"] * { visibility: hidden !important; }' });
    }
    await page.evaluate(() => {
      editor.commands.setContent("<p>AV office affinity tail</p>");
      editor.commands.focus(); editor.commands.setTextSelection({ from: 2, to: 8 });
    });
    const shaping = await page.evaluate(() => {
      const measure = () => { const r = document.createRange(); r.selectNodeContents(editor.view.dom.firstElementChild); return r.getBoundingClientRect().width; };
      const selected = measure(); editor.commands.setTextSelection(2); return { selected, plain: measure() };
    });
    assert.ok(Math.abs(shaping.selected - shaping.plain) < .1, JSON.stringify(shaping));
    await page.waitForTimeout(600); // Separate typing from setContent in Yjs undo.
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await page.evaluate(() => editor.state.selection.to - editor.state.selection.from), 1);
    await page.evaluate(() => editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    assert.equal(await page.locator(".text-range-selected").count(), 0, "no decoration DOM changes during composition");
    await page.evaluate(() => editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await page.waitForFunction(() => document.querySelector(".text-range-selected"));
    await page.keyboard.type("Z");
    assert.equal(await page.evaluate(() => editor.state.doc.textContent), "AZ office affinity tail");
    await page.evaluate(() => editor.commands.undo());
    assert.equal(await page.evaluate(() => editor.state.doc.textContent), "AV office affinity tail");
    await page.evaluate(() => { editor.commands.setTextSelection({ from: 1, to: 10 }); editor.commands.setSearchTerm("office"); });
    await page.locator(".find-highlight").first().waitFor();
    const findCount = await page.locator(".find-highlight").count();
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal(await page.locator(".find-highlight").count(), findCount, "selection preserves find feedback");
    await page.evaluate(() => editor.commands.setSearchTerm(""));
    await page.locator(".find-highlight").first().waitFor({ state: "detached" });
    const performance = await page.evaluate(() => {
      editor.commands.setContent({ type: "doc", content: Array.from({ length: 3000 }, () => ({ type: "paragraph", content: [{ type: "text", text: "A long note with selected text" }] })) });
      const start = window.performance.now(); editor.commands.selectAll();
      const elapsed = window.performance.now() - start;
      return { elapsed, spans: editor.view.dom.querySelectorAll(".text-range-selected").length };
    });
    console.log("3000-block selection", JSON.stringify(performance));
    assert.equal(performance.spans, 3000);
    assert.ok(performance.elapsed < 2000, `select-all stays responsive: ${performance.elapsed}ms`);
  } finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
