import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';

test('text quotes insert atomically through the normal note owner and survive HTML and Yjs', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    if (process.env.PDF_CPU_LOAD) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 6 });
    page.on('pageerror', console.error);
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()};
      window.receipts = []; window.uploads = 0;
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === 'get_content') return { state: [], updates: [], files: [] };
        if (command === 'add_update') { window.receipts.push(args); return { id: window.receipts.length, bytes: args.bytes }; }
        if (command === 'save_file') { window.uploads++; throw new Error('Text must never upload'); }
        throw new Error('Unexpected command: ' + command);
      } } });`);
    // Reader controls can subscribe after a quick focus/caret/blur cycle as
    // the native workspace opens. The editor still owns a valid selection.
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-text-quotes.html?late-reader`);
    await page.waitForFunction(() => window.textQuoteTest);
    await page.evaluate(() => {
      const { editor } = window.textQuoteTest;
      editor.commands.setContent('<p>Before after</p>');
      editor.commands.focus(8);
    });
    await page.getByRole('button', { name: 'Open reader', exact: true }).click();
    await page.evaluate(() => window.textQuoteTest.pendingPdfQuote.setState(() => ({
      id: 'late-reader', moduleId: 'quote-module', kind: 'text', status: 'draft',
      parts: [{ text: 'Late reader quote', source: { documentId: 'pdf-one', page: 1, name: 'Lecture.pdf', region: { x: .1, y: .2, width: .5, height: .4 } } }],
    })));
    await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
    const lateText = await page.locator('.tiptap').textContent();
    assert.ok(lateText.indexOf('Before') < lateText.indexOf('Late reader quote') && lateText.indexOf('Late reader quote') < lateText.lastIndexOf('after'), lateText);
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-text-quotes.html`);
    await page.waitForFunction(() => window.textQuoteTest);
    const parts = [1, 2].map(page => ({ text: page === 1 ? '<script>unsafe & editable</script>\nSecond line' : 'Next page', source: { documentId: 'pdf-one', page, name: 'Lecture.pdf', region: { x: .1, y: .2, width: .5, height: .4 } } }));
    await page.evaluate(() => { const { editor } = window.textQuoteTest; editor.commands.setContent('<p>before after</p>'); editor.commands.setTextSelection({ from: 8, to: 13 }); });
    const inserted = await page.evaluate(parts => {
      const { editor, owner } = window.textQuoteTest;
      let transactions = 0;
      const count = ({ transaction }) => { if (transaction.docChanged) transactions++; };
      editor.on('transaction', count); owner.insertTextQuote(editor, parts, { position: editor.state.selection.from }); editor.off('transaction', count);
      const json = editor.getJSON(); const html = editor.getHTML();
      editor.commands.undo(); const undone = editor.getText(); editor.commands.redo();
      return { json, html, undone, transactions };
    }, parts);
    assert.equal(inserted.transactions, 1); assert.equal(inserted.undone, 'before after');
    const quotes = inserted.json.content.filter(node => node.type === 'pdfTextQuote');
    assert.equal(quotes.length, 2);
    assert.deepEqual(quotes.map(node => node.attrs.pdfSource), parts.map(part => part.source));
    assert.ok(quotes.every(node => /^[0-9a-f-]{36}$/.test(node.attrs.quoteId) && !('imageId' in node.attrs)));
    assert.notEqual(quotes[0].attrs.quoteId, quotes[1].attrs.quoteId);
    assert.equal(inserted.json.content[0].content[0].text, 'before '); assert.equal(inserted.json.content.at(-1).content[0].text, 'after');
    assert.ok(inserted.html.includes('&lt;script&gt;'));
    const persisted = await page.evaluate(async html => {
      const { editor, Y, Editor, noteExtensions, flushAll } = window.textQuoteTest;
      await flushAll({ timeoutMs: 5000 });
      const restored = new Y.Doc(); for (const receipt of window.receipts) Y.applyUpdate(restored, new Uint8Array(receipt.bytes));
      const clone = new Editor({ extensions: noteExtensions({ document: restored }) });
      await new Promise(resolve => setTimeout(resolve, 50));
      const rehydrated = clone.getJSON(); clone.destroy();
      const clipboard = new Editor({ extensions: noteExtensions({ document: new Y.Doc() }) });
      clipboard.commands.setContent(html + '<blockquote><p>Ordinary quote</p></blockquote>');
      const roundtrip = clipboard.getJSON(); clipboard.destroy();
      const id = editor.getJSON().content.find(node => node.type === 'pdfTextQuote').attrs.quoteId;
      let position; editor.state.doc.descendants((node, pos) => { if (node.attrs.quoteId === id) position = pos + 2; });
      editor.commands.insertContentAt(position, 'Edited ');
      return { rehydrated, roundtrip, edited: editor.getJSON().content.find(node => node.attrs?.quoteId === id), uploads: window.uploads, modules: window.receipts.map(r => r.moduleId) };
    }, inserted.html);
    assert.deepEqual(persisted.rehydrated.content.filter(n => n.type === 'pdfTextQuote'), quotes);
    const pastedQuotes = persisted.roundtrip.content.filter(n => n.type === 'pdfTextQuote');
    assert.deepEqual(pastedQuotes.map(n => n.attrs), quotes.map(n => n.attrs));
    assert.deepEqual(pastedQuotes.map(n => n.content.map(p => p.content)), quotes.map(n => n.content.map(p => p.content)));
    assert.equal(persisted.roundtrip.content.filter(n => n.type === 'blockquote').length, 1);
    assert.deepEqual(persisted.edited.attrs, quotes[0].attrs);
    assert.ok(persisted.edited.content[0].content[0].text.startsWith('Edited '));
    assert.equal(persisted.uploads, 0); assert.ok(persisted.modules.length && persisted.modules.every(id => id === 'quote-module'));
    const copied = await page.evaluate(() => {
      const { editor } = window.textQuoteTest;
      const before = editor.getJSON().content.filter(node => node.type === 'pdfTextQuote').map(node => node.attrs.quoteId);
      editor.commands.setTextSelection(1);
      editor.view.pasteHTML(editor.getHTML());
      const after = editor.getJSON().content.filter(node => node.type === 'pdfTextQuote').map(node => node.attrs.quoteId);
      return { before, after };
    });
    assert.equal(copied.after.length, copied.before.length * 2);
    assert.equal(new Set(copied.after).size, copied.after.length, 'pasted quotes need their own source-navigation identities');
    assert.ok(copied.before.every(id => copied.after.includes(id)), 'original quote identities stay stable');
    const denied = await page.evaluate(parts => {
      const { editor, owner, Editor, Y, noteExtensions } = window.textQuoteTest;
      const before = JSON.stringify(editor.getJSON());
      const attempt = (target = { position: 1 }, value = parts) => { try { owner.insertTextQuote(editor, value, target); return false; } catch { return true; } };
      editor.setEditable(false); const readOnly = attempt(); editor.setEditable(true);
      owner.editorRef.current = null; const wrongEditor = attempt(); owner.editorRef.current = editor;
      const other = new Editor({ extensions: noteExtensions({ document: new Y.Doc() }) });
      owner.editorRef.current = other;
      let wrongDocument = false;
      try { owner.insertTextQuote(other, parts, { position: 1 }); } catch { wrongDocument = true; }
      owner.editorRef.current = editor; other.destroy();
      const invalidPosition = attempt({ position: -1 }); const missingSection = attempt({ headingId: 'missing' });
      const invalidParts = attempt({ position: 1 }, [...parts, { ...parts[0], text: '' }]);
      return { readOnly, wrongEditor, wrongDocument, invalidPosition, missingSection, invalidParts, unchanged: before === JSON.stringify(editor.getJSON()), uploads: window.uploads };
    }, parts);
    assert.deepEqual(denied, { readOnly: true, wrongEditor: true, wrongDocument: true, invalidPosition: true, missingSection: true, invalidParts: true, unchanged: true, uploads: 0 });
    await page.evaluate(parts => window.textQuoteTest.pendingPdfQuote.setState(() => ({ id: crypto.randomUUID(), moduleId: 'quote-module', kind: 'text', parts: [{ ...parts[0], text: '' }], status: 'draft' })), parts);
    await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'invalid' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry images', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.textQuoteTest.pendingPdfQuote.state.status), 'draft');
    await page.evaluate(parts => window.textQuoteTest.pendingPdfQuote.setState(current => ({ ...current, parts })), parts);
    await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => window.textQuoteTest.pendingPdfQuote.state === null);
    assert.equal(await page.evaluate(() => window.uploads), 0);
    const sections = await page.evaluate(parts => {
      const { editor, owner } = window.textQuoteTest;
      editor.commands.setContent({ type: 'doc', content: [
        { type: 'heading', attrs: { level: 1, 'data-toc-id': 'section-one' }, content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'First body' }] },
        { type: 'heading', attrs: { level: 1, 'data-toc-id': 'section-two' }, content: [{ type: 'text', text: 'Second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second body' }] },
      ] });
      owner.insertTextQuote(editor, [parts[0]], { headingId: 'section-one' });
      owner.insertTextQuote(editor, [parts[1]], { headingId: null });
      return editor.getJSON().content.map(node => node.type === 'pdfTextQuote' ? `quote ${node.attrs.pdfSource.page}` : node.content?.map(n => n.text).join(''));
    }, parts);
    assert.deepEqual(sections.filter(Boolean), ['First', 'First body', 'quote 1', 'Second', 'Second body', 'quote 2']);
  } finally { await browser?.close(); await server.close(); }
});
