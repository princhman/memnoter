import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { browserHarness } from './support/browser.mjs';
const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, url;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, plugins: [{name:"worksheet-provider", resolveId(id) { if(id === "/worksheet-test-provider") return id; }, load(id) { if(id === "/worksheet-test-provider") return 'export { QueryClientProvider } from "@tanstack/react-query";'; }}, { name: "worksheet-test-entries", configResolved(config) { config.optimizeDeps.entries = ["index.html"]; } }], optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "yjs"] }, logLevel: 'error' });
  await server.listen(); browser = await webkit.launch();
  url = `http://localhost:${server.httpServer.address().port}`;
});
after(async () => { await browser?.close(); await server?.close(); });
test('failed answer isolation, explicit conflict recovery, and lifecycle draining', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.addInitScript(() => {
    window.saved = [];
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
      if (command === 'worksheet_answer_document_load') return { document: [0, 0], expected: 'fresh', plainText: null };
      if (command === 'worksheet_answer_document_save') {
        window.saved.push(args);
        if (args.leafPartId === 'bad' && args.expected !== 'fresh') throw new Error('This answer changed elsewhere');
        return { bank: { answers: { [JSON.stringify([args.attemptId, args.revisionId, args.leafPartId])]: { text: 'saved' } } }, expected: 'ack' };
      }
      if (command.startsWith('plugin:')) return 1;
      if (['modules', 'documents', 'list_documents', 'unindexed_modules', 'unindexed_card_modules'].includes(command)) return [];
      if (command === 'sync_status') return { enabled: false, account: null };
      return null;
    } } });
  });
  await page.goto(url);
  const result = await page.evaluate(async cacheDir => {
    const { default: React } = await import(`/@fs/${cacheDir}/deps/react.js`);
    const { act } = React;
    window.IS_REACT_ACT_ENVIRONMENT = true;
    const { default: { createRoot } } = await import(`/@fs/${cacheDir}/deps/react-dom_client.js`);
    const { useWorksheetAnswers, flushWorksheetAnswers } = await import('/src/lib/worksheet-session.ts');
    const { exclusiveWrite, flushAll } = await import('/src/lib/write-lifecycle.ts');
    const legacyKey = JSON.stringify(['legacy', 'r', 'part']);
    localStorage.setItem('worksheet-drafts:' + JSON.stringify(['m', 'legacy']), JSON.stringify({ [legacyKey]: { revisionId: 'r', leafPartId: 'part', text: 'retained plain text' } }));
    let answers, legacy, ready = false;
    function Owner() { answers = useWorksheetAnswers('m', 'a'); legacy = useWorksheetAnswers('m', 'legacy'); React.useEffect(() => { ready = true; }, []); return null; }
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => { root.render(React.createElement(Owner)); });
    await act(async () => {
      answers.setDocument('r', 'bad', [0, 0], 'stale', 'bad', true);
      answers.setDocument('r', 'good', [0, 0], 'base', 'good', true);
      await flushWorksheetAnswers();
    });
    const isolated = window.saved.map(x => x.leafPartId).join(',') === 'bad,good' && Object.keys(answers.errors).length === 1 && Object.keys(answers.drafts).length === 1;
    let strictBlocked = false;
    let retainedBeforeConfirmation = false;
    await act(async () => {
      await flushAll({ navigation: true });
      try { await flushAll(); } catch { strictBlocked = true; }
      const conflict = await answers.retryAnswer('r', 'bad');
      retainedBeforeConfirmation = conflict === 'fresh' && !window.saved.some(x => x.leafPartId === 'bad' && x.expected === 'fresh');
      await answers.retryAnswer('r', 'bad', conflict);
      try { await legacy.loadDocument('r', 'part'); } catch {}
    });
    const legacyRecovery = !!legacy.errors[legacyKey];
    let durableAtExit = false;
    await act(async () => {
      await legacy.retryAnswer('r', 'part', await legacy.retryAnswer('r', 'part'));
      // Rejected before IPC: a resolved running promise must not wedge future saves.
      answers.setDocument('r', 'invalid', [255], 'base', 'invalid', true);
      await flushWorksheetAnswers();
      answers.discardAnswer('r', 'invalid');
      answers.setDocument('r', 'last', [0, 0], 'base', 'last edit', true);
      try { await exclusiveWrite(async () => { durableAtExit = window.saved.some(x => x.leafPartId === 'last'); throw new Error('cancel exit'); }, { kind: 'exit' }); } catch (e) { if (e.message !== 'cancel exit') throw e; }
    });
    const { WorksheetAnswerEditor } = await import('/src/components/worksheet-answer-editor.tsx');
    let openedEmptyWrites = 0;
    await act(async () => { root.render(React.createElement(WorksheetAnswerEditor, { moduleId: 'm', attemptId: 'empty', revisionId: 'r', leafPartId: 'p', label: 'Empty', load: async () => ({ document: [0, 0], expected: '[]', plainText: '' }), save: () => openedEmptyWrites++, flush: () => {}, flushDurable: async () => {} })); });
    while (!document.querySelector('.tiptap')) await new Promise(resolve => setTimeout(resolve, 10));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    await act(async () => { root.unmount(); });
    return { isolated, strictBlocked, legacyRecovery, retainedBeforeConfirmation, openedEmptyWrites, rebased: window.saved.some(x => x.leafPartId === 'bad' && x.expected === 'fresh'), durableAtExit };
  }, server.config.cacheDir);
  assert.deepEqual(result, { isolated: true, strictBlocked: true, legacyRecovery: true, retainedBeforeConfirmation: true, openedEmptyWrites: 0, rebased: true, durableAtExit: true });
});

test('Linux worksheet drawing publishes editable assets only after durable answer acknowledgement and reopens', async t => {
  const page = await browser.newPage({ viewport: {width:1100,height:800} }); t.after(() => page.close());

  await page.addInitScript(() => {
    Object.defineProperty(navigator,'platform',{value:'Linux x86_64'}); Object.defineProperty(navigator,'userAgent',{value:'Linux browser'}); window.assets = {};
    window.installTestBridge({tauri:{invoke:async (command,args) => {
      if(command==='save_file') { const id=crypto.randomUUID(); window.assets[id]=args.bytes; return {id,path:id,file_type:args.mimeType}; }
      if(command==='worksheet_canvas_save') {
        window.legacyReceipt=args;
        const revision={sourceId:args.sourceId,previewId:args.previewId,width:args.width,height:args.height};
        return {bank:{answers:{[JSON.stringify(['a','r','p'])]:{canvases:{legacy:{revision,copies:[]}},canvasOrder:['legacy']}}}};
      }
      if(command==='read_file') return {bytes:window.assets[args.fileId]};
      if(command==='resolve_card_image') { const bytes=window.assets[args.fileId]; return bytes ? URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'image/png'})) : null; }
      if(command.startsWith('plugin:')) return 1;
      if(['modules','documents','list_documents','unindexed_modules','unindexed_card_modules'].includes(command)) return [];
      if(command==='sync_status') return {enabled:false,account:null};
      return null;
    }}});
  });
  await page.goto(url);
  await page.evaluate(async cacheDir => {
    const {default:React}=await import(`/@fs/${cacheDir}/deps/react.js`);
    const {default:{createRoot}}=await import(`/@fs/${cacheDir}/deps/react-dom_client.js`);
    const {WorksheetAnswerEditor}=await import('/src/components/worksheet-answer-editor.tsx');
    const { MODULE_CONTENT_SYNCED_EVENT } = await import('/src/lib/sync/apply-remote.ts');
    const Y = await import(`/@fs/${cacheDir}/deps/yjs.js`);
    window.syncAnswerText = () => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(window.answerBytes));
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Text from another device');
      paragraph.insert(0, [text]);
      doc.getXmlFragment('default').insert(0, [paragraph]);
      window.answerBytes = Array.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      window.dispatchEvent(new CustomEvent(MODULE_CONTENT_SYNCED_EVENT, { detail: 'm' }));
    };
    window.answerBytes=[0,0]; window.blockAck=true;
    window.newAnswerRoot=()=>{const host=document.body.appendChild(document.createElement("div"));host.style.cssText="position:fixed;inset:80px 100px;background:var(--background);z-index:40;overflow:auto";return createRoot(host);}; window.answerRoot=window.newAnswerRoot();
    window.mountAnswer=() => window.answerRoot.render(React.createElement(WorksheetAnswerEditor,{moduleId:'m',attemptId:'a',revisionId:'r',leafPartId:'p',label:'Portable',
      load:async()=>({document:window.answerBytes,expected:'base',plainText:null}),
      refresh:async (_expected, isCurrent, apply) => {
        if (!isCurrent()) return false;
        apply({document:window.answerBytes,expected:'peer text',plainText:null});
        return true;
      },
      save:bytes=>window.answerBytes=bytes,flush:()=>{},flushDurable:async()=> { if(window.blockAck && Object.keys(window.assets).length) throw new Error('Durable answer save unavailable'); }
    })); window.mountAnswer();
  },server.config.cacheDir);
  const answer=page.locator('.worksheet-answer-input');
  await answer.waitFor(); await answer.click(); await page.keyboard.type('/drawing');
  await page.getByRole('option', {name:'Drawing',exact:true}).waitFor(); await page.keyboard.press('Enter');
  const paper=page.getByLabel('Drawing paper'); await paper.waitFor(); const box=await paper.boundingBox();
  await page.mouse.move(box.x+40,box.y+40); await page.mouse.down(); await page.mouse.move(box.x+140,box.y+90,{steps:5}); await page.mouse.up();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Retry drawing save',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('portable-ink:'))),'failed acknowledgement retains ink');
  await page.evaluate(()=>window.blockAck=false); await page.getByRole('button',{name:'Retry drawing save',exact:true}).click();
  await page.waitForFunction(()=>!Object.keys(localStorage).some(k=>k.startsWith('worksheet-inline-drawing:')||k.startsWith('portable-ink:')));
  assert.equal(await page.evaluate(()=>Object.values(window.assets).map(b=>{try{return JSON.parse(new TextDecoder().decode(new Uint8Array(b)))}catch{return null}}).filter(d=>d?.portable?.strokes.length===1).length),1);
  await page.evaluate(()=>{window.answerRoot.unmount();window.answerRoot=window.newAnswerRoot();window.mountAnswer();});
  await page.locator('.worksheet-answer-input .note-image-host img').waitFor();
  await page.locator('.worksheet-answer-input .note-image-host img').dblclick();
  await paper.waitFor();
  await page.evaluate(() => window.syncAnswerText());
  await answer.getByText('Text from another device', { exact: true }).waitFor({ state: 'attached' });
  await page.mouse.move(box.x+80,box.y+180); await page.mouse.down(); await page.mouse.move(box.x+160,box.y+220); await page.mouse.up();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForFunction(()=>!Object.keys(localStorage).some(k=>k.startsWith('worksheet-inline-drawing:')||k.startsWith('portable-ink:')));
  assert.match(await answer.innerText(), /Text from another device/);
  await page.evaluate(async cacheDir=>{
    window.answerRoot.unmount(); window.answerRoot=window.newAnswerRoot();
    const {default:React}=await import(`/@fs/${cacheDir}/deps/react.js`);
    const {QueryClientProvider}=await import('/worksheet-test-provider');
    const {queryClient}=await import('/src/lib/query-client.ts');
    const {WorksheetDrawings}=await import('/src/components/worksheet-drawings.tsx');
    const [sourceId,previewId]=Object.keys(window.assets);
    window.answerRoot.render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(WorksheetDrawings,{moduleId:'m',attemptId:'a',revisionId:'r',leafPartId:'p',answer:{canvases:{legacy:{revision:{sourceId,previewId,width:1024,height:1440},copies:[]}},canvasOrder:['legacy']}})));
  },server.config.cacheDir);
  await page.getByRole('button',{name:'Edit drawing',exact:true}).click(); await paper.waitFor();
  await page.mouse.move(box.x+80,box.y+180); await page.mouse.down(); await page.mouse.move(box.x+160,box.y+220); await page.mouse.up();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Reopen local drawing',exact:true}).click(); await paper.waitFor();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForFunction(()=>!!window.legacyReceipt && !Object.keys(localStorage).some(k=>k.startsWith('worksheet-drawing:')||k.startsWith('portable-ink:')));
  assert.equal(await page.evaluate(()=>window.legacyReceipt.canvasId),'legacy');
  await page.evaluate(()=>window.answerRoot.unmount());
});

test('remote sync refreshes an open worksheet and keeps conflicting local typing', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'userAgent', { value: 'Mac browser' });
    localStorage.setItem('worksheet-open:sync-test', 'a');
    window.installTestBridge({ tauri: { invoke: async (command, args) => {
      if (command === 'question_bank_get' && args.moduleId === 'sync-test') return window.bank;
      if (command === 'worksheet_answer_document_load') return window.savedAnswer;
      if (command === 'worksheet_answer_document_save') {
        window.lastExpected = args.expected;
        if (window.holdAcknowledgement) {
          window.holdAcknowledgement = false;
          return new Promise(resolve => {
            const bank = window.bank;
            window.releaseAcknowledgement = () => resolve({ bank, expected: 'Acknowledged local edit' });
          });
        }
        throw new Error('This answer changed elsewhere');
      }
      if (command === 'read_file' && window.previews?.[args.fileId]) {
        const data = await fetch(window.previews[args.fileId]);
        return { bytes: [...new Uint8Array(await data.arrayBuffer())], file_type: 'image/png' };
      }
      if (command === 'resolve_card_image') {
        if (args.fileId === 'ink-preview-2') return new Promise(resolve => {
          window.releasePreview = () => resolve(window.previews[args.fileId]);
        });
        return window.previews[args.fileId];
      }
      if (command.startsWith('plugin:')) return 1;
      if (['modules', 'documents', 'list_documents', 'unindexed_modules', 'unindexed_card_modules'].includes(command)) return [];
      if (command === 'sync_status') return { enabled: false, account: null };
      return null;
    } } });
  });
  await page.goto(url);
  await page.evaluate(async cacheDir => {
    const { default: React } = await import(`/@fs/${cacheDir}/deps/react.js`);
    const { default: { createRoot } } = await import(`/@fs/${cacheDir}/deps/react-dom_client.js`);
    const Y = await import(`/@fs/${cacheDir}/deps/yjs.js`);
    const { QueryClientProvider } = await import('/worksheet-test-provider');
    const { queryClient } = await import('/src/lib/query-client.ts');
    const { QuestionBank } = await import('/src/components/question-bank.tsx');
    const { onRemote } = await import('/src/lib/sync/manager.ts');
    window.previews = {};
    for (const [revision, width] of [[1, 200], [2, 300]]) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = 100;
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, 100);
      context.fillStyle = 'black';
      context.fillRect(10, 10, 10, 10);
      window.previews['ink-preview-' + revision] = canvas.toDataURL();
    }
    const setSaved = (questionTitle, text, drawing) => {
      const doc = new Y.Doc();
      const paragraph = new Y.XmlElement('paragraph');
      const content = new Y.XmlText();
      content.insert(0, text);
      paragraph.insert(0, [content]);
      const fragment = doc.getXmlFragment('default');
      fragment.insert(0, [paragraph]);
      if (drawing) {
        const image = new Y.XmlElement('image');
        image.setAttribute('imageId', 'ink');
        image.setAttribute('drawing', { version: 1, sourceId: 'ink-source-' + drawing, previewId: 'ink-preview-' + drawing });
        fragment.insert(1, [image]);
      }
      window.savedAnswer = { document: Array.from(Y.encodeStateAsUpdate(doc)), expected: text, plainText: null };
      window.bank = {
        questions: { q: { title: questionTitle, order: 0, revisionId: 'r' } },
        revisions: { r: { questionId: 'q', rootPartId: 'p', parts: { p: { label: '', cropIds: [] } } } },
        crops: {},
        attempts: { a: { title: 'Sync worksheet', questions: [{ questionId: 'q', revisionId: 'r' }] } },
        answers: { [JSON.stringify(['a', 'r', 'p'])]: { text, canvases: {}, canvasOrder: [] } },
      };
      doc.destroy();
    };
    let sequence = 0;
    window.applyRemote = (...args) => {
      setSaved(...args);
      onRemote({ updates: [{ moduleId: 'sync-test', update: { id: ++sequence, bytes: [0, 0] } }],
        deleted: [], modulesChanged: false, reviewsChanged: false, filesChanged: false });
    };
    setSaved('Original question', 'Original answer', false);
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'position:fixed;inset:80px 100px;overflow:auto;z-index:40;background:var(--background)';
    const root = createRoot(host);
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(QuestionBank, { moduleId: 'sync-test' })));
  }, server.config.cacheDir);
  const answer = page.locator('.worksheet-answer-input');
  await answer.getByText('Original answer', { exact: true }).waitFor();
  await page.evaluate(() => window.applyRemote('Renamed question', 'Synced answer', 1));
  await page.getByRole('article', { name: 'Question Renamed question' }).waitFor();
  await answer.getByText('Synced answer', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.worksheet-answer-input .note-image-host img')?.naturalWidth === 200);
  const preview = answer.locator('.note-image-host img').first();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForFunction(() => {
    const img = document.querySelector('.worksheet-answer-input .note-image-host img');
    if (!img?.complete || !img.naturalWidth) return false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3] === 0
      && context.getImageData(15, 15, 1, 1).data[0] > 240;
  });
  const oldWidth = await preview.evaluate(img => img.getBoundingClientRect().width);

  await page.evaluate(() => window.applyRemote('Renamed question', 'Synced ink revision', 2));
  await page.waitForFunction(() => !!window.releasePreview);
  await answer.getByText('Synced ink revision', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.worksheet-answer-input .note-image-host img')?.naturalWidth === 200);
  assert.equal(await preview.evaluate(img => img.getBoundingClientRect().width), oldWidth);
  assert.equal(await answer.getByRole('status').count(), 0, 'keep the existing worksheet preview visible without a spinner');
  await page.evaluate(() => window.releasePreview());
  await page.waitForFunction(() => document.querySelector('.worksheet-answer-input .note-image-host img')?.naturalWidth === 300);

  await page.evaluate(() => { window.holdAcknowledgement = true; });
  await answer.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' local edit');
  await page.waitForFunction(() => !!window.releaseAcknowledgement);
  await page.evaluate(() => {
    window.applyRemote('Question with newer answer', 'Synced after local save', 1);
    window.releaseAcknowledgement();
  });
  await answer.getByText('Synced after local save', { exact: true }).waitFor();

  await answer.fill('Synced after local save my draft');
  await page.evaluate(() => window.applyRemote('Renamed again', 'Conflicting answer', false));
  await page.getByRole('article', { name: 'Question Renamed again' }).waitFor();
  await page.getByRole('alert').filter({ hasText: /^This answer changed elsewhere Your draft is retained\.$/ }).waitFor();
  assert.match(await answer.innerText(), /Synced after local save my draft/);
  assert.equal(await page.evaluate(() => window.lastExpected), 'Synced after local save');
});
