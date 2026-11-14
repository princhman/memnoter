import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

test("real card decorations hide braces and tint prose and rendered math in either theme", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => !!window.editor);
    await page.evaluate(() => editor.commands.setContent({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Recall {{answer " }, { type: "inlineMath", content: [{ type: "text", text: "x^2" }] }, { type: "text", text: "}}" }] },
      { type: "paragraph", content: [{ type: "text", text: "Question :: Answer" }] },
    ] }));
    for (const dark of [false, true]) for (const active of [false, true]) {
      await page.evaluate(({ dark, active }) => {
        document.documentElement.classList.toggle("dark", dark);
        editor.commands.setTextSelection(active ? 5 : editor.state.doc.content.size - 1);
      }, { dark, active });
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const styles = await page.evaluate(() => {
        const read = selector => [...document.querySelectorAll(selector)].map(el => {
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          return { text: el.textContent, size: parseFloat(s.fontSize), display: s.display, background: s.backgroundColor, shadow: s.boxShadow, width: r.width, height: r.height };
        });
        return { braces: read(".cloze-brace"), text: read(".cloze-text"), math: read(".cloze-math .inline-math-widget") };
      });
      assert.ok(styles.braces.length >= 2);
      assert.ok(styles.braces.every(s => s.size === 0 && s.display !== "none"));
      assert.ok(styles.text.length > 0 && styles.math.length > 0);
      for (const s of [...styles.text, ...styles.math]) {
        assert.notEqual(s.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(s.shadow, "none", "answers remain underlined");
      }
      assert.ok(styles.text.some(s => s.width > 0 && s.height > 0));
      assert.ok(styles.math.every(s => s.width > 0 && s.height > 0));
      assert.equal(styles.text[0].background, styles.math[0].background);
    }
    assert.equal(await page.evaluate(() => editor.state.doc.textContent), "Recall {{answer x^2}}Question :: Answer");
  } finally { await browser?.close(); await server.close(); }
});

test("group editing, hover and dot focus preserve geometry while exposing syntax and answer details", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => !!window.editor);
    await page.evaluate(() => {
      const p = text => ({ type: "paragraph", content: [{ type: "text", text }] });
      editor.commands.setContent({ type: "doc", content: [p("Steps? ::list"), { type: "bulletList", content: ["First", "Second"].map(text => ({ type: "listItem", content: [p(text)] })) }, p("::end"), p("Why? ::block"), { ...p("Because "), content: [{ type: "text", text: "Because " }, { type: "inlineMath", content: [{ type: "text", text: "x^2" }] }] }, p("Another reason"), { type: "mathBlock", content: [{ type: "text", text: "x^2 + y^2" }] }, p("::end"), p("Outside"), p("ordinary {{cloze}}") ] });
      editor.commands.setCardSchedules([], Date.now());
    });
    const outside = async () => {
      await page.evaluate(() => { const e = editor; e.commands.setTextSelection(e.state.doc.content.size - 3); e.view.focus(); });
      await page.mouse.move(5, 5);
    };
    const metrics = () => page.evaluate(() => {
      const read = selector => [...document.querySelectorAll(selector)].map(el => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return { visibility: s.visibility, color: s.color, height: r.height, width: r.width, x: r.x, y: r.y, shadow: s.boxShadow, background: s.backgroundColor };
      });
      const geometry = selector => [...document.querySelectorAll(selector)].map(el => {
        const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      });
      return { geometry: { blocks: geometry('.tiptap > :not(.card-group-closer), .tiptap li > p'), dots: geometry('.card-group-question > .card-info') }, endMarkers: read('.card-group-end-marker'), markers: read(".card-group-opener"), closers: read(".card-group-closer"), answers: read(".card-group-answer-text"), content: editor.state.doc.toJSON() };
    });
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      await outside();
      const resting = await metrics();
      assert.equal(resting.markers.length, 2);
      assert.ok(resting.markers.every(s => s.color === "rgba(0, 0, 0, 0)" && s.width > 0));
      assert.ok(resting.closers.every(s => s.height === 0));
      assert.ok(resting.answers.every(s => s.shadow === "none" && s.background === "rgba(0, 0, 0, 0)"));
      assert.equal(await page.getByText(/Reveal one by one|Reveal together|[12]\/2/).count(), 0);
      for (const [groupIndex, answerIndex] of [[0, 0], [1, 2]]) {
        // Place the caret inside an answer, rather than only on the question.
        await page.evaluate(groupIndex => {
          let at = 0; const target = groupIndex ? "Because " : "First";
          editor.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent.startsWith(target)) at = pos + 1; });
          editor.commands.setTextSelection(at); editor.view.focus();
        }, groupIndex);
        const active = await metrics();
        assert.notEqual(active.markers[groupIndex].color, "rgba(0, 0, 0, 0)");
        assert.ok(active.closers.every(s => s.height === 0), "editing source stays out of flow");
        assert.equal(active.endMarkers[groupIndex].visibility, 'visible');
        assert.equal(active.endMarkers[1 - groupIndex].visibility, 'hidden');
        assert.deepEqual(active.geometry, resting.geometry, "editing must not move or resize any block or dot");
        assert.equal(active.closers[1 - groupIndex].height, 0);
        assert.deepEqual([active.markers[groupIndex].x, active.markers[groupIndex].width], [resting.markers[groupIndex].x, resting.markers[groupIndex].width]);
        // Opening the closer must not move that group's question or answers.
        assert.deepEqual([active.answers[answerIndex].x, active.answers[answerIndex].y], [resting.answers[answerIndex].x, resting.answers[answerIndex].y]);
        await outside();
        const dot = page.locator('.card-group-question > .card-info').nth(groupIndex);
        await dot.hover();
        const hovered = await metrics();
        const clozeShadow = await page.locator('.cloze-text').evaluate(el => getComputedStyle(el).boxShadow);
        assert.equal(hovered.answers[answerIndex].shadow, clozeShadow);
        assert.notEqual(clozeShadow, "none");
        if (groupIndex === 1) {
          for (const selector of ['.card-group-answer-math .inline-math-widget', '.card-group-answer-formula .katex-display']) {
            assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).boxShadow), clozeShadow, "rendered math shares the answer underline");
          }
        }
        assert.equal(hovered.answers[groupIndex ? 0 : 2].shadow, "none", "the other card stays plain");
        assert.ok(hovered.closers.every(s => s.height === 0), "hovering does not reveal syntax");
        assert.deepEqual(hovered.geometry, resting.geometry);
        await page.mouse.move(5, 5);
        await dot.focus();
        const focused = await metrics();
        assert.deepEqual(focused.geometry, resting.geometry, "keyboard focus keeps all geometry fixed");
        assert.equal(focused.answers[answerIndex].shadow, clozeShadow);
        const description = groupIndex ? 'Block card: Reveals together' : 'List card: Reveals one by one';
        assert.equal(await dot.getAttribute('aria-label'), `${description}. Card details`);
        assert.equal(await dot.getByText(description, { exact: true }).isVisible(), true);
        assert.deepEqual(hovered.content, resting.content, "focus and hover do not edit saved syntax or identities");
      }
    }
  } finally { await browser?.close(); await server.close(); }
});
