import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { browserHarness } from './support/browser.mjs';
const { createServer, webkit } = browserHarness(import.meta.url);
let server, browser, url;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, plugins: [{ name: "worksheet-test-entries", configResolved(config) { config.optimizeDeps.entries = ["index.html"]; } }], optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "yjs"] }, logLevel: 'error' });
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
    const { default: { createRoot } } = await import(`/@fs/${cacheDir}/deps/react-dom_client.js`);
    const { useWorksheetAnswers, flushWorksheetAnswers } = await import('/src/lib/worksheet-session.ts');
    const { exclusiveWrite, flushAll } = await import('/src/lib/write-lifecycle.ts');
    const legacyKey = JSON.stringify(['legacy', 'r', 'part']);
    localStorage.setItem('worksheet-drafts:' + JSON.stringify(['m', 'legacy']), JSON.stringify({ [legacyKey]: { revisionId: 'r', leafPartId: 'part', text: 'retained plain text' } }));
    let answers, legacy;
    function Owner() { answers = useWorksheetAnswers('m', 'a'); legacy = useWorksheetAnswers('m', 'legacy'); return null; }
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    root.render(React.createElement(Owner));
    while (!answers) await new Promise(resolve => setTimeout(resolve, 10));
    answers.setDocument('r', 'bad', [0, 0], 'stale', 'bad', true);
    answers.setDocument('r', 'good', [0, 0], 'base', 'good', true);
    await flushWorksheetAnswers();
    await new Promise(resolve => setTimeout(resolve, 20));
    const isolated = window.saved.map(x => x.leafPartId).join(',') === 'bad,good' && Object.keys(answers.errors).length === 1 && Object.keys(answers.drafts).length === 1;
    await flushAll({ navigation: true });
    let strictBlocked = false;
    try { await flushAll(); } catch { strictBlocked = true; }
    await answers.retryAnswer('r', 'bad');
    try { await legacy.loadDocument('r', 'part'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
    const legacyRecovery = !!legacy.errors[legacyKey];
    await legacy.retryAnswer('r', 'part');
    // Rejected before IPC: a resolved running promise must not wedge future saves.
    answers.setDocument('r', 'invalid', [255], 'base', 'invalid', true);
    await flushWorksheetAnswers();
    answers.discardAnswer('r', 'invalid');
    answers.setDocument('r', 'last', [0, 0], 'base', 'last edit', true);
    let durableAtExit = false;
    try { await exclusiveWrite(async () => { durableAtExit = window.saved.some(x => x.leafPartId === 'last'); throw new Error('cancel exit'); }, { kind: 'exit' }); } catch (e) { if (e.message !== 'cancel exit') throw e; }
    const { WorksheetAnswerEditor } = await import('/src/components/worksheet-answer-editor.tsx');
    let openedEmptyWrites = 0;
    root.render(React.createElement(WorksheetAnswerEditor, { moduleId: 'm', attemptId: 'empty', revisionId: 'r', leafPartId: 'p', label: 'Empty', load: async () => ({ document: [0, 0], expected: '[]', plainText: '' }), save: () => openedEmptyWrites++, flush: () => {}, flushDurable: async () => {} }));
    while (!document.querySelector('.tiptap')) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 100));
    root.unmount();
    return { isolated, strictBlocked, legacyRecovery, openedEmptyWrites, rebased: window.saved.some(x => x.leafPartId === 'bad' && x.expected === 'fresh'), durableAtExit };
  }, server.config.cacheDir);
  assert.deepEqual(result, { isolated: true, strictBlocked: true, legacyRecovery: true, openedEmptyWrites: 0, rebased: true, durableAtExit: true });
});
