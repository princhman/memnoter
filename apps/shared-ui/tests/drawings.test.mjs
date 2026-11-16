import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '@tiptap/core';
import { editorExtensions } from './support/editor.mjs';
import { noteDrawingPersistence } from '../src/editor-host/drawings.ts';
import { noteDrawingOwner } from '../src/lib/drawing.ts';
import { execEditor } from '../src/editor-host/commands.ts';
import { browserHarness } from './support/browser.mjs';

const { createServer, webkit } = browserHarness(import.meta.url);

test('drawing revisions update only their embed, retry safely, and reject stale or removed targets', () => {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this text' }] }] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const images = () => {
    const result = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') result.push({ node, pos }); });
    return result;
  };
  try {
    editor.commands.setTextSelection(5);
    assert.equal(execEditor(editor, 'beginDrawing', { imageId: 'first' }), true);
    assert.equal(execEditor(editor, 'beginDrawing', { imageId: 'first' }), true);
    assert.equal(images().length, 1, 'retry must not duplicate an embed');
    assert.match(editor.state.doc.textContent, /Keep/);
    const firstRevision = { imageId: 'first', sourceId: 'source-1', previewId: 'preview-1', expectedSourceId: null };
    assert.equal(execEditor(editor, 'commitDrawing', firstRevision), true);
    assert.equal(execEditor(editor, 'commitDrawing', firstRevision), true);
    assert.deepEqual(images()[0].node.attrs.drawing, { version: 1, sourceId: 'source-1', previewId: 'preview-1' });
    editor.commands.setNodeSelection(images()[0].pos);
    execEditor(editor, 'beginDrawing', { imageId: 'second' });
    assert.equal(images().length, 2, 'inserting beside a selected drawing must not replace it');
    execEditor(editor, 'commitDrawing', { ...firstRevision, imageId: 'second', sourceId: 'source-2', previewId: 'preview-2' });
    execEditor(editor, 'commitDrawing', { ...firstRevision, expectedSourceId: 'source-1', sourceId: 'source-3', previewId: 'preview-3' });
    const before = editor.getJSON();
    assert.throws(() => execEditor(editor, 'commitDrawing', { ...firstRevision, sourceId: 'stale', previewId: 'stale' }), /changed/);
    assert.deepEqual(editor.getJSON(), before);
    assert.equal(images().find(x => x.node.attrs.imageId === 'second').node.attrs.drawing.sourceId, 'source-2');
    assert.equal(execEditor(editor, 'discardEmptyDrawing', { imageId: 'first' }), false, 'discard must never remove a saved drawing');
    const first = images().find(x => x.node.attrs.imageId === 'first');
    editor.view.dispatch(editor.state.tr.delete(first.pos, first.pos + first.node.nodeSize));
    assert.throws(() => execEditor(editor, 'commitDrawing', { ...firstRevision, expectedSourceId: 'source-3' }), /removed/);
  } finally { editor.destroy(); }
});

test('note owner adapter keeps both source/preview pairs when publishing a conflict copy', () => {
  const editor = new Editor({ element: null, extensions: editorExtensions({ collaborative: false }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] } });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    execEditor(editor, 'beginDrawing', { imageId: 'original' });
    execEditor(editor, 'commitDrawing', { imageId: 'original', sourceId: 'peer-source', previewId: 'peer-preview', expectedSourceId: null });
    const persistence = noteDrawingPersistence(editor, noteDrawingOwner('module', 'original'));
    const revision = { sourceId: 'local-source', previewId: 'local-preview', expectedSourceId: 'old-source', asCopy: false };
    assert.throws(() => persistence.publish(revision), /changed/);
    const copyId = persistence.publish({ ...revision, asCopy: true });
    const images = editor.getJSON().content.filter(node => node.type === 'image');
    assert.equal(images.length, 2);
    assert.deepEqual(images.find(node => node.attrs.imageId === 'original').attrs.drawing,
      { version: 1, sourceId: 'peer-source', previewId: 'peer-preview' });
    assert.deepEqual(images.find(node => node.attrs.imageId === copyId).attrs.drawing,
      { version: 1, sourceId: 'local-source', previewId: 'local-preview' });
    assert.throws(() => noteDrawingPersistence(editor, { moduleId: 'module', answerId: 'answer', canvasId: 'canvas' }), /not a note/);
  } finally { editor.destroy(); }
});

test('desktop WebKit displays an iPad drawing and retains its editable references through text edits and reopening', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: (command, args) => {
        if (command === "resolve_card_image" && args.fileId === "png-preview-2" && document.querySelector(".note-image-host img")?.naturalWidth === 200) return new Promise(resolve => {
          window.releasePreview = () => resolve(localStorage.getItem(args.fileId));
        });
        if (command === "resolve_card_image" && args.fileId.startsWith("png-preview")) return Promise.resolve(localStorage.getItem(args.fileId));
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      } } });
    });
    const url = `http://localhost:${server.httpServer.address().port}/tests/browser/images.html`;
    await page.goto(url);
    await page.waitForFunction(() => !!window.editor);
    const reference = { version: 1, sourceId: 'native-source', previewId: 'png-preview' };
    await page.evaluate(async reference => {
      const Y = window.Y;
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
      const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 200, 100);
      context.fillStyle = '#713ac7'; context.fillRect(20, 30, 160, 4);
      localStorage.setItem("png-preview", canvas.toDataURL());
      canvas.width = 240;
      localStorage.setItem("png-preview-2", canvas.toDataURL());
      const ipad = window.ipadDocument = new Y.Doc();
      const image = new Y.XmlElement('image');
      for (const [key, value] of Object.entries({ fileId: reference.previewId, drawing: reference, imageId: 'drawing-id', alt: 'Synced drawing', src: null })) image.setAttribute(key, value);
      const paragraph = new Y.XmlElement('paragraph'); const text = new Y.XmlText(); text.insert(0, 'iPad explanation'); paragraph.insert(0, [text]);
      ipad.getXmlFragment('default').insert(0, [image, paragraph]);
      editor.commands.clearContent();
      const desktop = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration').options.document;
      Y.applyUpdate(desktop, Y.encodeStateAsUpdate(ipad));
    }, reference);
    await page.waitForFunction(() => document.querySelector('.note-image-host img')?.naturalWidth === 200);
    await page.locator('.tiptap p').filter({ hasText: 'iPad explanation' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited on Mac');
    const caret = await page.evaluate(() => {
      const desktop = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration').options.document;
      Y.applyUpdate(window.ipadDocument, Y.encodeStateAsUpdate(desktop));
      window.previewElement = document.querySelector('.note-image-host img');
      return editor.state.selection.toJSON();
    });
    await page.evaluate(() => {
      const image = window.ipadDocument.getXmlFragment('default').toArray().find(node => node.nodeName === 'image');
      window.ipadDocument.transact(() => {
        image.setAttribute('fileId', 'png-preview-2');
        image.setAttribute('drawing', { version: 1, sourceId: 'native-source-2', previewId: 'png-preview-2' });
      });
      const desktop = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration').options.document;
      Y.applyUpdate(desktop, Y.encodeStateAsUpdate(window.ipadDocument));
    });
    await page.waitForFunction(() => !!window.releasePreview);
    assert.equal(await page.locator('.note-image-loading').isVisible(), true);
    assert.equal(await page.locator('.note-image-host img').evaluate(img => img.naturalWidth), 200, 'keep the old preview while downloading');
    await page.evaluate(() => window.releasePreview());
    await page.waitForFunction(() => document.querySelector('.note-image-host img')?.naturalWidth === 240);
    assert.equal(await page.evaluate(() => window.previewElement === document.querySelector('.note-image-host img')), true, 'preview updates must keep the mounted image DOM');
    assert.equal(await page.evaluate(() => document.activeElement === editor.view.dom), true, 'preview arrival must retain DOM focus');
    assert.deepEqual(await page.evaluate(() => editor.state.selection.toJSON()), caret, 'peer drawing revision must preserve the text caret');
    await page.keyboard.type(' after sync');
    assert.match(await page.locator('.tiptap').textContent(), /edited on Mac after sync/);
    Object.assign(reference, { sourceId: 'native-source-2', previewId: 'png-preview-2' });
    const returned = await page.evaluate(async () => {
      const Y = window.Y;
      const desktop = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration').options.document;
      const update = Y.encodeStateAsUpdate(desktop);
      Y.applyUpdate(window.ipadDocument, update);
      const children = window.ipadDocument.getXmlFragment('default').toArray();
      return { update: [...update], drawing: children.find(node => node.nodeName === 'image').getAttribute('drawing'), text: window.ipadDocument.getXmlFragment('default').toString() };
    });
    assert.deepEqual(returned.drawing, reference, 'desktop edits must preserve the native source and preview pair');
    assert.match(returned.text, /edited on Mac/);
    await page.reload();
    await page.waitForFunction(() => !!window.editor);
    await page.evaluate(async update => {
      const Y = window.Y;
      editor.commands.clearContent();
      const desktop = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration').options.document;
      Y.applyUpdate(desktop, new Uint8Array(update));
    }, returned.update);
    await page.waitForFunction(() => document.querySelector('.note-image-host img')?.naturalWidth === 240);
    assert.deepEqual(await page.evaluate(() => editor.getJSON().content.find(node => node.type === 'image').attrs.drawing), reference);
    assert.match(await page.locator('.tiptap').textContent(), /edited on Mac/);
  } finally { await browser?.close(); await server.close(); }
});

test('Mac drawing sessions preserve existing draft slots, clean only new slots, and recover deleted targets as copies', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command === 'edit_drawing') {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (window.outcome === 'save') editor.commands.setContent('<p>Removed by peer</p>');
          return { status: window.outcome, asCopy: false, hasChanges: false, expectedSourceId: null,
            source: { id: 'saved-source', path: '/source', file_type: 'json' }, preview: { id: 'saved-preview', path: '/preview', file_type: 'png' } };
        }
        if (command === 'drawing_committed') { window.acknowledged = args.imageId; return null; }
        if (command === 'resolve_card_image') throw new Error('Not downloaded');
        throw new Error(`Unexpected command: ${command}`);
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.waitForFunction(() => !!window.editor);
    for (const existing of [true, false]) for (const status of ['empty', 'cancel', 'discarded', 'active']) {
      const ids = await page.evaluate(async ({ existing, status }) => {
        editor.commands.setContent(existing ? { type: 'doc', content: [{ type: 'image', attrs: { imageId: 'peer-slot', drawing: { version: 1, sourceId: null, previewId: null } } }, { type: 'paragraph' }] } : '<p></p>');
        window.outcome = status;
        const { openMacDrawing } = await import('/src/lib/mac-drawing.ts');
        await openMacDrawing(editor, 'note', existing ? { imageId: 'peer-slot', sourceId: null } : undefined);
        return editor.getJSON().content.filter(node => node.type === 'image').map(node => node.attrs.imageId);
      }, { existing, status });
      assert.deepEqual(ids, existing ? ['peer-slot'] : [], `${status}: only a slot created by this session may be automatically removed`);
    }
    await page.evaluate(async () => {
      editor.commands.setContent('<p>Resume typing</p>');
      editor.view.focus();
      window.outcome = 'cancel';
      const { openMacDrawing } = await import('/src/lib/mac-drawing.ts');
      await openMacDrawing(editor, 'note');
    });
    assert.equal(await page.evaluate(() => document.activeElement === editor.view.dom), true, 'closing the native canvas must leave the editor ready for typing');
    await page.keyboard.type('continued');
    assert.match(await page.locator('.tiptap').textContent(), /continued/);
    const recovered = await page.evaluate(async () => {
      editor.commands.setContent({ type: 'doc', content: [{ type: 'image', attrs: { imageId: 'peer-slot', drawing: { version: 1, sourceId: null, previewId: null } } }, { type: 'paragraph' }] });
      window.outcome = 'save';
      const { openMacDrawing } = await import('/src/lib/mac-drawing.ts');
      await openMacDrawing(editor, 'note', { imageId: 'peer-slot', sourceId: null });
      return { images: editor.getJSON().content.filter(node => node.type === 'image').map(node => node.attrs), text: editor.state.doc.textContent, acknowledged: window.acknowledged };
    });
    assert.equal(recovered.images.length, 1);
    assert.notEqual(recovered.images[0].imageId, 'peer-slot');
    assert.deepEqual(recovered.images[0].drawing, { version: 1, sourceId: 'saved-source', previewId: 'saved-preview' });
    assert.match(recovered.text, /Removed by peer/);
    assert.equal(recovered.acknowledged, 'peer-slot');
  } finally { await browser?.close(); await server.close(); }
});
