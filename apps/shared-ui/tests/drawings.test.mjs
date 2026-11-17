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
      Object.defineProperty(navigator, "platform", {value:"MacIntel"});
      Object.defineProperty(navigator, "userAgent", {value:"Mac browser"});
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

test('portable ink recovers drafts, publishes immutable editable sources, and protects missing or legacy ink', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64' }); Object.defineProperty(navigator, 'userAgent', { value: 'Linux browser' }); window.assets = {};
      window.installTestBridge({ tauri: { invoke: async (cmd, args) => {
        if (cmd === 'save_file') { const id = crypto.randomUUID(); window.assets[id] = args.bytes; return { id, path: id, file_type: args.mimeType }; }
        if (cmd === 'read_file') { if (!window.assets[args.fileId]) throw new Error('Source not downloaded'); return { bytes: window.assets[args.fileId] }; }
        throw new Error(`Unexpected ${cmd}`);
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/images.html`);
    await page.evaluate(async () => {
      const { call } = await import('/src/lib/backend.ts');
      window.openInk = sourceId => { window.result = null; void call('edit_drawing', { moduleId: 'm', imageId: 'canvas', sourceId }).then(r => window.result = r); };
      window.openInk(null);
    });
    const paper = page.getByLabel('Drawing paper'); await paper.waitFor(); const box = await paper.boundingBox();
    const draw = async y => { await page.mouse.move(box.x+40,box.y+y); await page.mouse.down(); await page.mouse.move(box.x+160,box.y+y+40,{steps:8}); await page.mouse.up(); };
    await draw(40); await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.waitForFunction(() => window.result?.status === 'cancel');
    assert.equal(await page.evaluate(() => window.result.hasChanges), true);
    await page.evaluate(() => window.openInk(null)); await paper.waitFor(); await page.getByText(/Recovered local draft/).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForFunction(() => window.result?.status === 'save');
    const first = await page.evaluate(() => ({ result: window.result, doc: JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[window.result.source.id]))) }));
    assert.equal(first.doc.version, 2); assert.equal(first.doc.portable.strokes.length, 1); assert.ok(first.doc.portable.strokes[0].points.length >= 8);
    assert.equal(first.result.source.file_type, 'application/vnd.memnoter.drawing+json');
    assert.ok(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('portable-ink:'))));
    await page.evaluate(async source => { const { call } = await import('/src/lib/backend.ts'); await call('drawing_committed', { moduleId:'m',imageId:'canvas' }); window.openInk(source); }, first.result.source.id);
    await paper.waitFor();
    await page.mouse.move(box.x+50,box.y+50); await page.mouse.down();
    await paper.dispatchEvent('pointercancel', {pointerId:1,pointerType:'mouse'}); await page.mouse.up();
    if (process.env.BROWSER === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:box.x+60,y:box.y+60,button:'left',buttons:1,clickCount:1,pointerType:'pen',force:.4});
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:box.x+90,y:box.y+90,button:'left',buttons:1,pointerType:'pen',force:.8});
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:box.x+90,y:box.y+90,button:'left',buttons:0,clickCount:1,pointerType:'pen'});
      assert.ok(await page.evaluate(() => Object.keys(localStorage).filter(k=>k.startsWith('portable-ink:')).some(k=>JSON.parse(localStorage[k]).document.portable.strokes.some(s=>s.points.some(p=>Math.abs(p.pressure-.4)<.01)))));
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      await page.getByLabel('Touch drawing').check();
      await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+200,y:box.y+200,radiusX:2,radiusY:2,force:.6}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+250,y:box.y+240,radiusX:2,radiusY:2,force:.6}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage[Object.keys(localStorage).find(k=>k.startsWith('portable-ink:'))]).document.portable.strokes.length),2);
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      await page.getByLabel('Touch drawing').uncheck(); await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false}); await cdp.detach();
    }
    await page.getByRole('button', {name:'Marker',exact:true}).click(); await draw(140);
    await page.getByRole('button',{name:'Eraser',exact:true}).click(); await page.mouse.click(box.x+40,box.y+40);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage[Object.keys(localStorage).find(k=>k.startsWith('portable-ink:'))]).document.portable.strokes.length),1);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await page.getByRole('button', {name:'Undo',exact:true}).click(); await page.getByRole('button', {name:'Redo',exact:true}).click();
    await page.getByRole('button', {name:'Done',exact:true}).click(); await page.waitForFunction(() => window.result?.status === 'save');
    assert.equal(await page.evaluate(() => JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[window.result.source.id]))).portable.strokes.length), 2);
    assert.equal(await page.evaluate(id => JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[id]))).portable.strokes.length, first.result.source.id), 1);
    await page.evaluate(async () => {
      const { call } = await import('/src/lib/backend.ts'); await call('drawing_committed', {moduleId:'m',imageId:'canvas'});
      try { await call('edit_drawing', {moduleId:'m',imageId:'missing',sourceId:'missing'}); } catch(e) { window.missingError=String(e); }
      window.assets.legacy=Array.from(new TextEncoder().encode(JSON.stringify({version:1,nativeData:'AQID',width:1024,height:1440,geometry:'masked'})));
      try { await call('edit_drawing', {moduleId:'m',imageId:'legacy',sourceId:'legacy'}); } catch(e) { window.legacyError=String(e); }
    });
    assert.match(await page.evaluate(() => window.missingError), /not downloaded/); assert.match(await page.evaluate(() => window.legacyError), /unsupported or legacy/);
    const { readFile } = await import('node:fs/promises');
    const fixture = JSON.parse(await readFile(new URL('../../ios/Tests/Fixtures/native-descriptors.json', import.meta.url), 'utf8'));
    await page.evaluate(fixture => {
      window.assets.native = Array.from(new TextEncoder().encode(JSON.stringify(fixture)));
      window.openInk('native');
    }, fixture);
    await paper.waitFor();
    const pixels = await paper.evaluate(c => {
      const ctx = c.getContext('2d');
      return [ctx.getImageData(130,130,1,1).data[0], ctx.getImageData(190,130,1,1).data[0], ctx.getImageData(30,50,1,1).data[0]];
    });
    assert.ok(pixels[0] < 255 && pixels[0] > 100, 'transformed translucent ink is visible');
    assert.deepEqual(pixels.slice(1), [255,255], 'clipped-away and untransformed ink must stay white');
    const rotated = await paper.evaluate(async c => {
      const {parseInk, paintInk, hitInk} = await import('/src/lib/portable-ink.ts');
      const doc = parseInk(JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets.native))));
      doc.portable.strokes[0].transform = [0,1,-1,0,200,100];
      // Masks follow drawing coordinates, independently of the stroke transform.
      for (const command of doc.portable.strokes[0].mask) {
        for (let i=0;i<command.coordinates.length;i+=2) {
          const [x,y] = command.coordinates.slice(i,i+2);
          command.coordinates[i]=280-y; command.coordinates[i+1]=x;
        }
      }
      const copy = document.createElement('canvas'); copy.width=c.width; copy.height=c.height;
      paintInk(copy,doc);
      return { visible:copy.getContext('2d').getImageData(150,130,1,1).data[0],
        clipped:copy.getContext('2d').getImageData(150,190,1,1).data[0],
        hit:hitInk(doc.portable.strokes[0],150,130), miss:hitInk(doc.portable.strokes[0],150,190) };
    });
    assert.ok(rotated.visible<255); assert.equal(rotated.clipped,255);
    assert.equal(rotated.hit,true); assert.equal(rotated.miss,false);
    await page.getByRole('button',{name:'Eraser',exact:true}).click();
    await page.mouse.click(box.x+190, box.y+130);
    const draftInk = () => page.evaluate(() => JSON.parse(localStorage[Object.keys(localStorage).find(k=>k.startsWith('portable-ink:'))]).document);
    assert.equal((await draftInk()).portable.strokes.length, 1, 'clipped area must not hit hidden ink');
    await page.mouse.click(box.x+130, box.y+130);
    assert.equal((await draftInk()).portable.strokes.length, 0, 'transformed visible ink is erasable');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    assert.deepEqual((await draftInk()).portable.strokes, fixture.portable.strokes);
    await page.getByRole('button',{name:'Pen',exact:true}).click(); await draw(240);
    await page.getByRole('button',{name:'Done',exact:true}).click(); await page.waitForFunction(()=>window.result?.status==='save');
    const nativeEdit = await page.evaluate(() => ({id:window.result.source.id, doc:JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[window.result.source.id])))}));
    assert.equal(nativeEdit.doc.version,2); assert.equal(nativeEdit.doc.portable.version,2);
    assert.equal(nativeEdit.doc.nativeData,fixture.nativeData);
    assert.deepEqual(nativeEdit.doc.portable.strokes[0],fixture.portable.strokes[0]);
    assert.equal(nativeEdit.doc.portable.strokes[1].tool,'pen');
    await page.evaluate(async id => {
      const {call}=await import('/src/lib/backend.ts'); await call('drawing_committed',{moduleId:'m',imageId:'canvas'}); window.openInk(id);
    }, nativeEdit.id);
    await paper.waitFor(); await page.getByRole('button',{name:'Eraser',exact:true}).click();
    await page.mouse.click(box.x+130,box.y+130);
    await page.getByRole('button',{name:'Done',exact:true}).click(); await page.waitForFunction(()=>window.result?.status==='save');
    const selected = await page.evaluate(()=>JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[window.result.source.id]))));
    assert.equal(selected.nativeData,fixture.nativeData); assert.equal(selected.portable.strokes.length,1);
    assert.equal(selected.portable.strokes[0].tool,'pen', 'stale archive must not resurrect erased indexed ink');
    await page.evaluate(async ()=>{const {call}=await import('/src/lib/backend.ts');await call('drawing_committed',{moduleId:'m',imageId:'canvas'});});
    await page.evaluate(async () => {
      const {openMacDrawing} = await import('/src/lib/mac-drawing.ts');
      window.editor.commands.setContent('<p>Portable note</p>'); window.noteDone=false;
      void openMacDrawing(window.editor,'m').then(()=>window.noteDone=true);
    });
    await paper.waitFor(); await draw(220);
    await page.getByRole('button',{name:'Done',exact:true}).click(); await page.waitForFunction(()=>window.noteDone);
    const note = await page.evaluate(()=>{
      const ref=window.editor.getJSON().content.find(n=>n.type==='image').attrs.drawing;
      return {ref, source:JSON.parse(new TextDecoder().decode(new Uint8Array(window.assets[ref.sourceId]))), preview:!!window.assets[ref.previewId], drafts:Object.keys(localStorage).filter(k=>k.startsWith('portable-ink:'))};
    });
    assert.equal(note.source.portable.strokes.length,1); assert.equal(note.preview,true); assert.deepEqual(note.drafts,[]);
  } finally { await browser?.close(); await server.close(); }
});


test('portable Apple round-trip fixture retains authoritative ink and rejects unknown geometry', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parseInk } = await import('../src/lib/portable-ink.ts');
  const fixture = JSON.parse(await readFile(new URL('../../ios/Tests/Fixtures/portable-drawing.json', import.meta.url), 'utf8'));
  const ink = parseInk(fixture);
  assert.equal(ink.nativeData, 'AQID');
  assert.deepEqual(ink.portable.strokes[0].points, [{x:30,y:40,pressure:1},{x:70,y:80,pressure:.5}]);
  assert.throws(() => parseInk({...fixture, portable:{version:3,strokes:[]}}), /unsupported/);
  assert.throws(() => parseInk({...fixture, portable:null}), /unsupported/);
  const native = JSON.parse(await readFile(new URL('../../ios/Tests/Fixtures/native-descriptors.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseInk(native).portable.strokes, native.portable.strokes);
  const descriptor = native.portable.strokes[0];
  for (const change of [{nativeIndex:-1}, {nativeIndex:.5}, {transform:[1,0]}, {points:[{...descriptor.points[0],width:Infinity}]}, {mask:[{command:'cubic',coordinates:[1,2]}]}]) {
    assert.throws(()=>parseInk({...native,portable:{version:2,strokes:[{...descriptor,...change}]}}), /unsupported/);
  }
  assert.throws(()=>parseInk({...native,nativeData:''}), /unsupported/);
  const {inkCanvasSize}=await import('../src/lib/portable-ink.ts');
  const long = parseInk({...native,height:100000});
  const size = inkCanvasSize(long);
  assert.ok(size.width*size.height < 4_220_000 && size.height<=16384);
  assert.equal(long.portable.strokes[0].points[0].x,-10);
});
