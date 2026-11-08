import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserHarness, installTestBridge } from './support/browser.mjs';
import { normalizePdfRegion, parsePdfSource } from '../src/lib/pdf-quote.ts';

// Protect the zoom/scroll-independent source contract, including reversed and off-page drags.
test('quote regions clamp to one page and reject tiny drags', () => {
  assert.deepEqual(normalizePdfRegion({ x: 180, y: 90 }, { x: -20, y: 20 }, { width: 200, height: 100 }), { x: 0, y: .2, width: .9, height: .7 });
  assert.deepEqual(normalizePdfRegion({ x: 360, y: 180 }, { x: -40, y: 40 }, { width: 400, height: 200 }), { x: 0, y: .2, width: .9, height: .7 });
  assert.equal(normalizePdfRegion({ x: 1, y: 1 }, { x: 3, y: 60 }, { width: 200, height: 100 }), null);
  const edgeRegion = normalizePdfRegion({ x: 22.4292192466947, y: 0 }, { x: 200, y: 100 }, { width: 200, height: 100 });
  assert.ok(parsePdfSource({ documentId: 'doc', page: 1, name: 'PDF', region: edgeRegion }));
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizePdfRegion({ x: invalid, y: 0 }, { x: 20, y: 20 }, { width: 100, height: 100 }), null);
    assert.equal(normalizePdfRegion({ x: 0, y: 0 }, { x: 20, y: 20 }, { width: invalid, height: 100 }), null);
  }
  for (const documentId of ['', ' ', 'doc\u0000']) {
    assert.equal(parsePdfSource({ documentId, page: 1, name: 'PDF', region: { x: 0, y: 0, width: 1, height: 1 } }), null);
  }
  for (const value of [null, {}, { documentId: 'doc', name: 'Lecture', page: 1, region: { x: .8, y: 0, width: .5, height: 1 } }]) assert.equal(parsePdfSource(value), null);
});

test('quote PNG pixels, mapped insertion, Yjs persistence, HTML and retry use the normal note owner', async () => {
  const { createServer } = browserHarness(import.meta.url);
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error(error));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    const setup = () => {
      window.receipts = []; window.uploads = []; window.releaseUpload = null;
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === 'get_content') return { state: [], updates: [], files: [] };
        if (command === 'save_file') {
          window.uploads.push(args);
          await new Promise(resolve => window.releaseUpload = resolve);
          return { id: `crop-${window.uploads.length}`, path: 'files/crop', file_type: args.mimeType };
        }
        if (command === 'add_update') { window.receipts.push(args); return { id: window.receipts.length, bytes: args.bytes }; }
        throw new Error(`Unexpected command: ${command}`);
      } } });
    };
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})();`);
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/pdf-quotes.html`);
    await page.waitForFunction(() => window.quoteTest);
    const source = { documentId: 'pdf-one', page: 7, name: 'Lecture.pdf', region: { x: .25, y: .25, width: .5, height: .5 } };
    const crop = await page.evaluate(async source => {
      const { editor, owner, cropPdfCanvas } = window.quoteTest;
      editor.commands.setContent('<p>before after</p>'); editor.commands.setTextSelection({ from: 8, to: 13 });
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 400, 200); ctx.fillStyle = '#00ff00'; ctx.fillRect(100, 50, 200, 100);
      const blob = await cropPdfCanvas(canvas, source.region);
      const bitmap = await createImageBitmap(blob); const check = document.createElement('canvas'); check.width = bitmap.width; check.height = bitmap.height;
      const pixels = check.getContext('2d'); pixels.drawImage(bitmap, 0, 0);
      window.insertion = owner.insertQuote(editor, new File([blob], 'quote.png', { type: 'image/png' }), source, { position: editor.state.selection.from }, () => {}, () => {});
      return { width: bitmap.width, height: bitmap.height, pixel: [...pixels.getImageData(0, 0, 1, 1).data] };
    }, source);
    assert.deepEqual(crop, { width: 200, height: 100, pixel: [0, 255, 0, 255] });
    await page.waitForFunction(() => window.releaseUpload);
    // Editing before the saved cursor must move insertion; a selected range must not be replaced.
    await page.evaluate(() => {
      const { owner, Y } = window.quoteTest;
      const remote = new Y.Doc(); Y.applyUpdate(remote, Y.encodeStateAsUpdate(owner.yDoc));
      remote.getXmlFragment('default').get(0).get(0).insert(0, 'NEW ');
      Y.applyUpdate(owner.yDoc, Y.encodeStateAsUpdate(remote));
      window.releaseUpload();
    });
    const saved = await page.evaluate(async () => {
      await window.insertion;
      const { editor, flushAll, Y } = window.quoteTest;
      await flushAll({ timeoutMs: 5000 });
      const restored = new Y.Doc();
      for (const receipt of window.receipts) Y.applyUpdate(restored, new Uint8Array(receipt.bytes));
      return { json: editor.getJSON(), html: editor.getHTML(), restored: [...restored.getXmlFragment('default').createTreeWalker(() => true)].filter(n => n instanceof Y.XmlElement && n.nodeName === 'image').map(n => n.getAttribute('pdfSource')), modules: window.receipts.map(r => r.moduleId), uploads: window.uploads.length };
    });
    assert.equal(saved.uploads, 1);
    assert.ok(saved.modules.every(id => id === 'quote-module'));
    assert.deepEqual(saved.json.content.filter(n => n.type === 'image').map(n => n.attrs.pdfSource), [source]);
    assert.equal(saved.json.content[0].content[0].text, 'NEW before ');
    assert.equal(saved.json.content.at(-1).content[0].text, 'after');
    assert.deepEqual(saved.restored, [source]);
    assert.ok(saved.html.includes('data-pdf-source='));
    const pasted = await page.evaluate(html => { window.quoteTest.editor.commands.setContent(html); return window.quoteTest.editor.getJSON().content.find(n => n.type === 'image').attrs; }, saved.html);
    assert.deepEqual(pasted.pdfSource, source);
    assert.deepEqual(pasted.masks, []);
    const mask = { id: 'mask-one', shape: 'rectangle', x: .1, y: .2, width: .3, height: .4 };
    const interoperable = await page.evaluate(({ source, mask }) => {
      const { editor } = window.quoteTest;
      editor.commands.setContent({ type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'inlineImage', attrs: { src: 'inline.png', fileId: 'inline-file', pdfSource: source, masks: [mask] } }] },
        { type: 'image', attrs: { src: 'plain.png', fileId: 'plain-file' } },
      ] });
      const html = editor.getHTML(); editor.commands.setContent(html);
      const json = editor.getJSON();
      return { inline: json.content[0].content[0], plain: json.content[1] };
    }, { source, mask });
    assert.equal(interoperable.inline.type, 'inlineImage');
    assert.deepEqual(interoperable.inline.attrs.pdfSource, source);
    assert.deepEqual(interoperable.inline.attrs.masks, [mask]);
    assert.equal(interoperable.plain.attrs.pdfSource, null);
    // Edge rounding must sample the final pixel without introducing transparency.
    const edge = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 2, 2);
      const blob = await window.quoteTest.cropPdfCanvas(canvas, { x: .99, y: .99, width: .01, height: .01 });
      const bitmap = await createImageBitmap(blob);
      const output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height;
      const pixels = output.getContext('2d'); pixels.drawImage(bitmap, 0, 0);
      return { width: output.width, height: output.height, pixel: [...pixels.getImageData(0, 0, 1, 1).data] };
    });
    assert.deepEqual(edge, { width: 1, height: 1, pixel: [18, 52, 86, 255] });
    // Rejected admission never uploads or registers a retryable image operation.
    const admission = await page.evaluate(async source => {
      const { editor, owner } = window.quoteTest;
      const before = window.uploads.length;
      editor.setEditable(false);
      const readOnly = await owner.insertQuote(editor, new File(['png'], 'denied.png'), source, { position: 1 }, () => {}, () => {}).then(() => false, () => true);
      editor.setEditable(true);
      owner.editorRef.current = null;
      const replaced = await owner.insertQuote(editor, new File(['png'], 'denied.png'), source, { position: 1 }, () => {}, () => {}).then(() => false, () => true);
      owner.editorRef.current = editor;
      return { readOnly, replaced, uploads: window.uploads.length - before };
    }, source);
    assert.deepEqual(admission, { readOnly: true, replaced: true, uploads: 0 });
    // A stable heading resolves after upload, despite edits changing all numeric positions.
    await page.evaluate(source => {
      const { editor, owner } = window.quoteTest;
      editor.commands.setContent({ type: 'doc', content: [
        { type: 'heading', attrs: { level: 1, 'data-toc-id': 'stable' }, content: [{ type: 'text', text: 'Section' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
        { type: 'heading', attrs: { level: 1, 'data-toc-id': 'next' }, content: [{ type: 'text', text: 'Next' }] },
      ] });
      window.releaseUpload = null;
      window.sectionInsert = owner.insertQuote(editor, new File(['png'], 'quote.png'), source, { headingId: 'stable' }, () => {}, () => {}).catch(error => String(error));
    }, source);
    await page.waitForFunction(() => window.releaseUpload);
    await page.evaluate(() => { window.quoteTest.editor.commands.insertContentAt(10, 'longer body'); window.releaseUpload(); });
    assert.equal(await page.evaluate(() => window.sectionInsert), undefined);
    const types = await page.evaluate(() => window.quoteTest.editor.getJSON().content.map(n => n.type));
    assert.deepEqual(types.slice(0, 4), ['heading', 'paragraph', 'image', 'heading']);
    // A failed insertion retains the upload receipt; retry must not save or insert twice.
    await page.evaluate(source => {
      const { editor, owner } = window.quoteTest;
      window.releaseUpload = null; window.completed = 0;
      window.retryInsert = owner.insertQuote(editor, new File(['png'], 'retry.png'), source, { headingId: 'stable' }, () => window.completed++, () => {}).catch(error => String(error));
    }, source);
    await page.waitForFunction(() => window.releaseUpload);
    await page.evaluate(() => {
      const { editor } = window.quoteTest;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { level: 1, 'data-toc-id': 'temporarily-missing' }));
      window.releaseUpload();
    });
    assert.match(await page.evaluate(() => window.retryInsert), /section was removed/);
    const retry = await page.evaluate(async () => {
      const { editor, retryFailedImages } = window.quoteTest;
      const uploads = window.uploads.length;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { level: 1, 'data-toc-id': 'stable' }));
      await retryFailedImages(); await retryFailedImages();
      return { uploadsBefore: uploads, uploadsAfter: window.uploads.length, completed: window.completed, images: editor.getJSON().content.filter(n => n.type === 'image').length };
    });
    assert.equal(retry.uploadsAfter, retry.uploadsBefore);
    assert.equal(retry.completed, 1);
    assert.equal(retry.images, 2);
    // Failed operations keep the pending draft through repeat failures and discard.
    const lifecycle = await page.evaluate(async source => {
      const { editor, owner, pendingPdfQuote } = window.quoteTest;
      const file = new File(['png'], 'discard.png');
      pendingPdfQuote.setState(() => ({ moduleId: 'quote-module', file, source, section: true, status: 'draft' }));
      window.releaseUpload = null;
      window.discardInsert = owner.insertQuote(editor, file, source, { headingId: 'gone' }, () => {}, () => {
        pendingPdfQuote.setState(draft => ({ ...draft, status: 'draft' }));
      }).catch(error => String(error));
      return window.uploads.length;
    }, source);
    await page.waitForFunction(() => window.releaseUpload);
    await page.evaluate(() => window.releaseUpload());
    assert.match(await page.evaluate(() => window.discardInsert), /section was removed/);
    const discarded = await page.evaluate(async () => {
      const { retryFailedImages, discardFailedImages, imageStatusStore, pendingPdfQuote } = window.quoteTest;
      await retryFailedImages();
      const failed = { status: pendingPdfQuote.state.status, errors: imageStatusStore.state.errors.length };
      discardFailedImages();
      return { failed, status: pendingPdfQuote.state.status, name: pendingPdfQuote.state.file.name, errors: imageStatusStore.state.errors.length, uploads: window.uploads.length };
    });
    assert.deepEqual(discarded, { failed: { status: 'error', errors: 1 }, status: 'draft', name: 'discard.png', errors: 0, uploads: lifecycle + 1 });
    // A consumer callback throwing after insertion must never make retry duplicate it.
    await page.evaluate(source => {
      const { editor, owner } = window.quoteTest;
      window.releaseUpload = null; window.notified = [];
      window.callbackInsert = owner.insertQuote(editor, new File(['png'], 'callback.png'), source, { headingId: null }, () => {
        window.notified.push('inserted'); throw new Error('test consumer failure');
      }, () => window.notified.push('disposed')).then(() => true, () => false);
    }, source);
    await page.waitForFunction(() => window.releaseUpload);
    await page.evaluate(() => window.releaseUpload());
    assert.equal(await page.evaluate(() => window.callbackInsert), true);
    assert.deepEqual(await page.evaluate(async () => {
      const { editor, retryFailedImages, imageStatusStore } = window.quoteTest;
      const count = editor.getJSON().content.filter(n => n.type === 'image').length;
      await retryFailedImages();
      return { count, after: editor.getJSON().content.filter(n => n.type === 'image').length, errors: imageStatusStore.state.errors.length, notified: window.notified };
    }), { count: 3, after: 3, errors: 0, notified: ['inserted', 'disposed'] });
    // Replacing the editor during upload cannot insert into either note, even on retry.
    await page.evaluate(source => {
      const { editor, owner } = window.quoteTest;
      window.releaseUpload = null; window.replacedCallbacks = [];
      window.replacedInsert = owner.insertQuote(editor, new File(['png'], 'replaced.png'), source, { headingId: null },
        () => window.replacedCallbacks.push('inserted'), () => window.replacedCallbacks.push('disposed')).catch(error => String(error));
    }, source);
    await page.waitForFunction(() => window.releaseUpload);
    await page.evaluate(() => { window.quoteTest.owner.editorRef.current = null; window.releaseUpload(); });
    assert.match(await page.evaluate(() => window.replacedInsert), /original note is closed/);
    assert.deepEqual(await page.evaluate(async () => {
      const { editor, retryFailedImages, discardFailedImages, imageStatusStore } = window.quoteTest;
      const uploads = window.uploads.length;
      await retryFailedImages();
      const failed = imageStatusStore.state.errors.length;
      discardFailedImages();
      window.quoteTest.owner.editorRef.current = editor;
      return { uploads: window.uploads.length - uploads, failed, callbacks: window.replacedCallbacks,
        count: editor.getJSON().content.filter(n => n.type === 'image').length };
    }), { uploads: 0, failed: 1, callbacks: ['disposed'], count: 3 });
    // Actual pointer selection uses capture, clamps off-page coordinates and cancels on Escape.
    const selection = page.getByLabel('Drag a region on this PDF page');
    const box = await selection.boundingBox();
    await page.mouse.move(box.x + 150, box.y + 70); await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 130); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.selectedRegion), { x: .75, y: .7, width: .25, height: .3 });
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.cancelled), true);
    // Malformed pasted provenance must not prevent ordinary images/masks from loading.
    const malformed = await page.evaluate(() => {
      const { editor } = window.quoteTest;
      editor.commands.setContent('<p>text</p><img src="test.png" data-pdf-source="broken">');
      return editor.getJSON().content.find(n => n.type === 'image').attrs;
    });
    assert.equal(malformed.pdfSource, null);
  } finally { await browser?.close(); await server.close(); }
});
