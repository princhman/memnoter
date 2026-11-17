import { browserHarness, waitForEditorSelection } from './support/browser.mjs';
import { chromium } from 'playwright';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';

const { createServer, webkit } = browserHarness(import.meta.url);
let server;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
});
after(async () => server?.close());
async function scenario(type, run) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
    await page.waitForFunction(() => window.editor);
    await page.addStyleTag({ content: 'html, body, #root { height: auto; overflow: visible; }' });
    await run(page);
    await page.close();
  } finally { await browser.close(); }
}
for (const [name, type] of [['WebKit', webkit], ['Chromium', chromium]]) {
  test(`${name}: PRI-348 copying inside a foldable block pastes only the selected text`, async () => scenario(type, async page => {
    for (const source of ['body', 'summary', 'whole']) {
      const data = await page.evaluate(source => {
        editor.commands.setContent('<details open><summary>Example title</summary><div data-type="detailsContent"><p>Before selected text after</p><p>Second line</p></div></details><p>Target: </p>');
        if (source === 'whole') editor.commands.setNodeSelection(0);
        else {
          let start;
          editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text.includes(source === 'body' ? 'selected text' : 'Example')) start = pos + (source === 'body' ? 7 : 0);
          });
          editor.commands.setTextSelection({ from: start, to: start + (source === 'body' ? 13 : 7) });
        }
        editor.view.focus();
        const clipboardData = new DataTransfer();
        editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        return { html: clipboardData.getData('text/html'), text: clipboardData.getData('text/plain') };
      }, source);
      if (source !== 'whole') {
        assert.equal(data.text, source === 'body' ? 'selected text' : 'Example');
        assert.doesNotMatch(data.html, /details|summary/);
      }
      await page.evaluate(data => {
        editor.commands.setContent('<p>Target:</p>');
        editor.commands.setTextSelection(8);
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/html', data.html); clipboardData.setData('text/plain', data.text);
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, data);
      assert.equal(await page.locator('.foldable-block').count(), source === 'whole' ? 1 : 0);
      if (source !== 'whole') assert.equal(await page.evaluate(() => editor.state.doc.textContent), `Target:${data.text}`);
    }
  }));
  test(`${name}: PRI-340 title caret and word selection diagnostic`, async () => scenario(type, async page => {
    await page.evaluate(() => {
      editor.commands.setContent('<h1>Memory study title</h1><p>Body here</p>');
      editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.view.focus();
    });
    const box = await page.locator('h1').boundingBox();
    await page.mouse.click(box.x + 85, box.y + box.height / 2);
    await page.waitForFunction(() => editor.state.selection.empty && editor.state.selection.head > 1 && editor.state.selection.head < 19);
    await waitForEditorSelection(page);
    // A separate double-click gesture, outside the first click's native interval.
    await page.waitForTimeout(600);
    await page.mouse.dblclick(box.x + 85, box.y + box.height / 2);
    await page.waitForFunction(() => getSelection().toString() === 'Memory');
    await waitForEditorSelection(page);
    assert.equal(await page.evaluate(() => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)), 'Memory');
  }));
  test(`${name}: PRI-349 undo restores the edit caret and scrolls it into view`, async () => scenario(type, async page => {
    await page.evaluate(() => {
      editor.commands.setContent('<p>first line</p>' + '<p>filler</p>'.repeat(80) + '<p>last line</p>');
      stopCapture(); editor.commands.setTextSelection(4); editor.view.focus();
    });
    await waitForEditorSelection(page);
    await page.keyboard.type('X');
    await page.evaluate(() => { stopCapture(); editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.scrollIntoView(); });
    await page.waitForFunction(() => scrollY > 500);
    const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
    await page.keyboard.press(`${mod}+z`);
    await page.waitForFunction(() => editor.state.doc.firstChild.textContent === 'first line');
    assert.equal(await page.evaluate(() => editor.state.selection.head), 4);
    await waitForEditorSelection(page);
    await page.waitForFunction(() => { const c = editor.view.coordsAtPos(editor.state.selection.head); return c.top >= 0 && c.bottom <= innerHeight; });
    await page.keyboard.press(`${mod}+Shift+z`);
    await page.waitForFunction(() => editor.state.doc.firstChild.textContent === 'firXst line');
    await waitForEditorSelection(page);
  }));
}
