import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor } from '@tiptap/core';
import { editorExtensions } from './support/editor.mjs';
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

test('desktop WebKit displays an iPad drawing and retains its editable references through text edits and reopening', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.addInitScript(() => {
      window.installTestBridge({ tauri: { invoke: (command, args) => {
        if (command === "resolve_card_image" && args.fileId === "png-preview") return Promise.resolve(localStorage.getItem("drawing-preview"));
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
      localStorage.setItem("drawing-preview", canvas.toDataURL());
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
    await page.waitForFunction(() => document.querySelector('.note-image-host img')?.naturalWidth === 200);
    assert.deepEqual(await page.evaluate(() => editor.getJSON().content.find(node => node.type === 'image').attrs.drawing), reference);
    assert.match(await page.locator('.tiptap').textContent(), /edited on Mac/);
  } finally { await browser?.close(); await server.close(); }
});
