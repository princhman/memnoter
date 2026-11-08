import { browserHarness } from "./support/browser.mjs";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, page;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen(); browser = await webkit.launch(); page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
  await page.waitForFunction(() => !!window.editor);
});
after(async () => { await browser?.close(); await server?.close(); });
async function setup(nodes = [{ type: "paragraph" }], position = 1, fallback = false) {
  await page.evaluate(async ({ nodes, position, fallback }) => {
    window.pasteEditor?.destroy();
    const { Editor, StarterKit, MarkdownPaste, noteExtensions } = await import('/tests/browser/paste-editor.ts');
    const host = document.createElement('div'); document.body.append(host);
    window.pasteEditor = new Editor({ element: host,
      extensions: fallback ? [StarterKit, MarkdownPaste] : noteExtensions({}).filter(e => !['collaboration', 'tableOfContents'].includes(e.name)).map(e => e.name === 'starterKit' ? e.configure({ undoRedo: {} }) : e),
      content: { type: 'doc', content: nodes },
    });
    pasteEditor.commands.setTextSelection(position);
  }, { nodes, position, fallback });
}
async function paste(source, options = {}) {
  return page.evaluate(({ source, options }) => {
    const data = new DataTransfer(); data.setData('text/plain', source);
    if (options.html) data.setData('text/html', options.html);
    if (options.file) data.items.add(new File(['image'], 'photo.png', { type: 'image/png' }));
    if (options.literal) pasteEditor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, shiftKey: true, bubbles: true }));
    pasteEditor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: pasteEditor.state.doc.textContent, json: pasteEditor.getJSON() };
  }, { source, options });
}
const p = text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

test("Markdown paste fits paragraphs, list items and headings; one undo restores document and selection", async () => {
  for (const [nodes, pos, expected] of [
    [[p('beforeafter')], 7, 'beforeboldafter'], [[p('')], 1, 'bold'],
    [[{ type: 'bulletList', content: [{ type: 'listItem', content: [p('item')] }] }], 5, 'itboldem'],
    [[{ ...p('Title'), type: 'heading', attrs: { level: 1 } }], 3, 'Tiboldtle'],
  ]) {
    await setup(nodes, pos);
    const before = await page.evaluate(() => pasteEditor.getJSON());
    assert.equal((await paste('**bold**')).text, expected);
    const restored = await page.evaluate(() => { pasteEditor.commands.undo(); return { json: pasteEditor.getJSON(), pos: pasteEditor.state.selection.from }; });
    assert.deepEqual(restored, { json: before, pos });
  }
});

test("older schemas keep table cells, highlights and formulas readable", async () => {
  await setup(undefined, 1, true);
  const result = await paste('| Name | Value |\n|---|---|\n| ==yellow== | $x_y$ |');
  assert.equal(result.text, 'NameValueyellowx_y');
  assert.ok(result.json.content.every(n => n.type === 'paragraph'));
});

test("native paste retains prose, internal HTML, file and raw code behavior", async () => {
  await setup(); assert.equal((await paste('ordinary prose')).text, 'ordinary prose');
  await setup(); assert.equal((await paste('**copied**', { html: '<p data-pm-slice="1 1 []">copied</p>' })).text, 'copied');
  await setup(); assert.equal((await paste('# image', { file: true })).text, '');
  await setup([{ type: 'codeBlock', content: [{ type: 'text', text: 'source' }] }], 3);
  assert.equal((await paste('**literal**')).text, 'so**literal**urce');
  await setup(); await page.evaluate(() => pasteEditor.setEditable(false));
  assert.equal((await paste('# Read only')).text, '');
});

test("reading-view HTML stays structured and Shift paste stays literal", async () => {
  await setup();
  const html = await paste('Reading view', { html: '<h1>Reading view</h1>' });
  assert.equal(html.json.content[0].type, 'heading');
  await setup();
  const literal = await paste('**literal**\n- raw', { literal: true });
  assert.equal(literal.text, '**literal**- raw');
  assert.ok(literal.json.content.every(n => n.type === 'paragraph' && n.content?.every(t => !t.marks?.length)));
});

test("Markdown headings normalize skipped levels in a single undo step", async () => {
  await setup();
  const result = await paste('# Root\n\n## Child\n\n#### Skipped\n\n## Sibling');
  assert.deepEqual(result.json.content.filter(n => n.type === 'heading').map(n => n.attrs.level), [1, 2, 3, 2]);
  await page.evaluate(() => pasteEditor.commands.undo());
  assert.equal(await page.evaluate(() => pasteEditor.state.doc.textContent), '');
});

test("pasted cards retain their identities across undo and redo", async () => {
  await setup(); await paste('# Study\n\nQuestion :: Answer\n\nRemember {{retrieval practice}}.');
  const result = await page.evaluate(async () => {
    const { extractCards } = await import('/src/lib/cards.ts');
    const ids = () => extractCards(pasteEditor.state.doc).map(c => c.id);
    const before = ids(); pasteEditor.commands.undo(); const undone = ids(); pasteEditor.commands.redo();
    return { before, undone, after: ids() };
  });
  assert.equal(result.before.length, 2); assert.equal(new Set(result.before).size, 2);
  assert.ok(result.before.every(id => typeof id === 'string' && id.length > 10));
  assert.deepEqual(result.undone, []); assert.deepEqual(result.after, result.before);
});
