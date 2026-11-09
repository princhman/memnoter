import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { textPdfBytes } from './browser/pdf-text-selection-pdf.mjs';

// The native shell/core and WK URL-scheme handler are the platform boundary.
// The host, editor owner, router, PDF.js, quote insertion and Yjs writes are real.
test('iPad workspace keeps the note cursor, quotes PDFs, follows sources, and adapts without remounting the note', async () => {
  const harness = browserHarness(import.meta.url);
  const server = await harness.createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  const content = new Map([['one', new Y.Doc()], ['two', new Y.Doc()]]);
  const annotations = new Y.Doc();
  const images = new Map();
  let documents = [];
  let revision = 0;
  let browser;
  try {
    await server.listen();
    browser = await (process.env.PDF_BROWSER === 'webkit' ? harness.webkit : chromium).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/native-asset/*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(images.get(route.request().url().split('/').pop())?.bytes ?? []) }));
    await page.route('**/text.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    await page.route('**/native-command', async route => {
      const { command, args } = route.request().postDataJSON();
      let result;
      switch (command) {
        case 'modules': result = [{ id: 'one', name: 'One', heading_numbering: false }, { id: 'two', name: 'Two', heading_numbering: false }]; break;
        case 'get_content': result = { state: Array.from(Y.encodeStateAsUpdate(content.get(args.moduleId))), updates: [], files: [...images.values()].filter(file => file.moduleId === args.moduleId).map(({id,path,file_type}) => ({id,path,file_type})) }; break;
        case 'add_update': Y.applyUpdate(content.get(args.moduleId), new Uint8Array(args.bytes)); result = { id: ++revision, bytes: args.bytes }; break;
        case 'sync_cards': case 'card_schedules': result = []; break;
        case 'index_note': result = null; break;
        case 'list_documents': result = documents.filter(doc => !args.moduleId || doc.moduleId === args.moduleId); break;
        case 'save_file': {
          assert.deepEqual(args.bytes.slice(0, 8), [137,80,78,71,13,10,26,10], 'native image quotes store the actual cropped PNG');
          result = { id: 'image-quote', path: 'files/image-quote', file_type: args.mimeType };
          images.set(result.id, { ...result, bytes: args.bytes, moduleId: args.moduleId }); break;
        }
        case 'read_file': result = images.get(args.fileId).bytes; break;
        case 'resolve_card_image': result = images.get(args.fileId).path; break;
        case 'document_path': result = '/app/files/text-pdf'; break;
        case 'load_annotations': result = { state: null, revision: 0, generation: 'native-test' }; break;
        case 'save_annotation_update': Y.applyUpdate(annotations, new Uint8Array(args.bytes)); result = { state: Array.from(Y.encodeStateAsUpdate(annotations)), revision: 1, generation: 'native-test' }; break;
        default: return route.fulfill({ status: 500, body: `Unexpected command ${command}` });
      }
      await route.fulfill({ json: result });
    });
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()};
      window.nativeMessages = [];
      let live = true;
      addEventListener("beforeunload", () => { live = false; });
      addEventListener("pagehide", () => { live = false; });
      window.installTestBridge({ native: message => {
        window.nativeMessages.push(message);
        if (message.kind === 'event') {
          if (message.event === 'openModule') queueMicrotask(() => window.memnoterEditor.open(message.payload.moduleId));
          return;
        }
        fetch('/native-command', { method: 'POST', body: JSON.stringify(message) }).then(async response => {
          if (!response.ok) throw new Error(await response.text());
          const result = await response.json();
          if (live) window.__memnoterBridge.resolve(message.id, result);
        }).catch(error => { if (live) window.__memnoterBridge.reject(message.id, error.message); });
      } });
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        const file = String(url).split('/').pop();
        return open.call(this, method, String(url).startsWith('memnoter-file://localhost/files/') ? file === 'text-pdf' ? '/text.pdf' : '/native-asset/' + file : url, ...rest);
      };
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        if (this instanceof HTMLImageElement && name === 'src' && String(value).startsWith('memnoter-file://localhost/files/')) value = '/native-asset/' + String(value).split('/').pop();
        return setAttribute.call(this, name, value);
      };`);
    const url = `http://localhost:${server.httpServer.address().port}/editor.html`;
    const openNote = async () => {
      await page.goto(url);
      await page.waitForFunction(() => window.memnoterEditor);
      await page.evaluate(() => window.memnoterEditor.open('one'));
    };
    await openNote();
    const note = page.locator('.tiptap');
    await note.click(); await page.keyboard.type('Before after');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await page.evaluate(() => window.memnoterEditor.flush());
    await note.evaluate(element => { window.originalNoteElement = element; });
    await page.evaluate(() => window.memnoterEditor.toggleFiles());
    const files = page.getByRole('complementary', { name: 'Files', exact: true });
    await files.getByText('No PDFs in this module yet', { exact: false }).waitFor();
    await files.getByRole('button', { name: 'Add PDF', exact: true }).click();
    assert.equal(await page.evaluate(() => window.nativeMessages.filter(m => m.event === 'pickPdfs').at(-1).payload.moduleId), 'one');
    documents = [{ id: 'text-pdf', moduleId: 'one', moduleName: 'One', name: 'Selection.pdf', size: 1000, pageCount: 3, createdAt: 0, available: true }];
    await page.evaluate(() => window.memnoterEditor.refreshDocuments('one'));
    await files.getByRole('button', { name: /Selection/ }).click();
    const span = files.locator('[data-pdf-page="1"] .textLayer span').filter({ hasText: 'Page 1 first line' });
    await span.waitFor();
    assert.equal(await note.evaluate(element => element === window.originalNoteElement), true);
    const noteBox = await note.boundingBox(), fileBox = await files.boundingBox();
    assert.ok(noteBox.x + noteBox.width <= fileBox.x + 1, 'wide layouts show the reader beside the note');
    await page.setViewportSize({ width: 650, height: 900 });
    await page.waitForFunction(() => document.querySelector('.native-editor-workspace').dataset.coveringNote === 'true');
    assert.equal(await note.evaluate(element => element === window.originalNoteElement), true, 'compact reading preserves the note instance');
    assert.equal(await note.isVisible(), false);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Native text handles produce a DOM range; preserve it through the action tap.
    await span.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await files.getByRole('button', { name: 'Quote text', exact: true }).click();
    await page.evaluate(() => { window.memnoterEditor.setTopInset(60); window.memnoterEditor.setBottomInset(250); });
    const quoteActions = page.getByRole('group', { name: 'Text quote actions', exact: true });
    const actionsBox = await quoteActions.boundingBox();
    assert.ok(actionsBox.y + actionsBox.height <= 650, 'quote actions stay above the native keyboard');
    assert.ok((await files.locator('.pdf-reader-tools').boundingBox()).y >= 60, 'reader tools stay below the native top inset');
    await page.evaluate(() => { window.memnoterEditor.setTopInset(0); window.memnoterEditor.setBottomInset(0); });
    await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
    await files.waitFor({ state: 'detached' });
    assert.equal(await note.evaluate(element => element === window.originalNoteElement), true);
    const text = await note.textContent();
    assert.ok(text.indexOf('Before') < text.indexOf('Page 1 first line'));
    assert.ok(text.indexOf('Page 1 first line') < text.lastIndexOf('after'), `quote inserts at the original cursor: ${text}`);
    await page.evaluate(() => window.memnoterEditor.flush());
    await note.getByRole('button', { name: 'Selection.pdf, page 1', exact: true }).first().click();
    await files.waitFor(); await span.waitFor();
    await files.getByRole('button', { name: /Show quote in note/ }).click();
    await files.waitFor({ state: 'detached' });
    assert.equal(await note.locator('.ProseMirror-selectednode').count(), 1, 'source marker reveals the saved quote in its note');
    await note.getByRole('button', { name: 'Selection.pdf, page 1', exact: true }).first().click();
    await files.waitFor(); await span.waitFor();
    await files.getByRole('button', { name: 'Select region', exact: true }).click();
    const region = files.getByLabel('Drag a region on this PDF page').first(); await region.waitFor();
    const box = await region.boundingBox();
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .25); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.up();
    await page.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
    await files.waitFor({ state: 'detached' });
    await note.locator('img').first().waitFor();
    assert.equal(images.get('image-quote').moduleId, 'one');
    await page.evaluate(() => window.memnoterEditor.flush());
    await openNote();
    await note.getByRole('button', { name: 'Selection.pdf, page 1', exact: true }).first().waitFor();
    assert.ok((await note.textContent()).includes('Page 1 first line'), 'the native core boundary rehydrates the inserted quote');
    await note.getByRole('button', { name: 'Selection.pdf, page 1', exact: true }).first().click();
    await files.waitFor(); await span.waitFor();
    await files.getByRole('button', { name: 'Open full screen', exact: true }).click();
    await page.getByRole('button', { name: 'Back to note', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open beside note', exact: true }).click();
    await files.getByRole('button', { name: 'All files', exact: true }).waitFor();
    await span.waitFor();
    await files.getByRole('button', { name: /^Zoom in/ }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"]').textContent === '110%');
    await files.getByLabel('Page number').fill('2'); await files.getByLabel('Page number').press('Enter');
    await page.waitForFunction(() => window.nativeMessages.some(m => m.event === 'pdfViewState' && m.payload.page === 2 && m.payload.zoom === 1.1), null, { timeout: 3000 });
    const savedPdfView = await page.evaluate(() => window.nativeMessages.filter(m => m.event === 'pdfViewState').at(-1).payload);
    await page.addInitScript(saved => {
      window.__memnoterPdfViewState = { [saved.documentId]: { page: saved.page, zoom: saved.zoom } };
      const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key.startsWith('pdf-view:')) throw new Error('Web storage unavailable'); return read.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('pdf-view:')) throw new Error('Web storage unavailable'); return write.call(this, key, value); };
    }, savedPdfView);
    await openNote();
    await page.evaluate(() => window.memnoterEditor.refreshDocuments('one'));
    await files.getByRole('button', { name: /Selection/ }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === '2' && document.querySelector('[aria-label="Zoom level"]').textContent === '110%');
    await page.evaluate(() => window.memnoterEditor.toggleFiles());
    await files.waitFor({ state: 'detached' });
    await page.evaluate(() => window.memnoterEditor.open('two'));
    await page.evaluate(() => window.memnoterEditor.refreshDocuments('one'));
    assert.equal(await files.count(), 0, 'late imports into another module do not open the current note’s panel');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); for (const doc of content.values()) doc.destroy(); annotations.destroy(); }
});
