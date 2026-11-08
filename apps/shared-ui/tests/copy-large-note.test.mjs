import { browserHarness } from "./support/browser.mjs";

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const { createServer, webkit } = browserHarness(import.meta.url);

test('massive note select-all and copy remain responsive; TOC ignores in-section selections', { timeout: 120000 }, async () => {
  const root = process.env.COPY_BENCH_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({ root, server: { port: 0, strictPort: false, hmr: false, watch: null, fs: { allow: [root, fileURLToPath(new URL('../../..', import.meta.url))] } }, logLevel: 'error' });
  let browser;
  try {
    server.middlewares.use('/course-asset', (_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    });
    await server.listen(); browser = await (process.env.COPY_PROFILE ? chromium : webkit).launch(process.env.COPY_CHROMIUM ? {executablePath:process.env.COPY_CHROMIUM} : {});
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/large-note.html`);
    await page.waitForFunction(() => !!window.openLargeNote);
    const text = Array.from({length: 1000}, (_, i) => `# Section ${i}\n\n## Topic ${i}\n\n${'Some editable paragraph text. '.repeat(10)}\n\n### Details ${i}\n\nA formula $x^2$ here.\n\n${i % 10 === 0 ? '| A | B |\n| --- | --- |\n| cell | value |\n\n$$\nx^2 + y^2\n$$\n\n![image](image.png)\n' : ''}`).join('\n');
    const stats = await page.evaluate(text => window.openLargeNote({name: 'Massive', entries: [{path:'Massive.md', text}, {path:'image.png'}]}), text);
    await page.waitForTimeout(400);
    let session;
    if (process.env.COPY_PROFILE) { session = await page.context().newCDPSession(page); await session.send('Profiler.enable'); await session.send('Profiler.start'); }
    const samples = await page.evaluate(async () => {
      editor.commands.setTextSelection(positions[0]); await paint();
      const commits = tocCommits.length;
      for (let i=1; i<=5; i++) { editor.commands.setTextSelection(positions[0]+i); await paint(); }
      const inSectionCommits = tocCommits.length - commits;
      editor.commands.setTextSelection(positions[positions.length - 1]); await paint();
      const crossedSection = !!document.querySelector('.toc-dash[aria-label="Details 999"]');
      timings.clear();
      const start = performance.now(); editor.commands.selectAll();
      const selection = performance.now() - start;
      await paint();
      const selectionPlugins = [...timings].map(([name, values]) => ({name, total:values.reduce((a,b)=>a+b,0)})).sort((a,b)=>b.total-a.total).slice(0,10);
      const stages = {};
      for (const plugin of editor.state.plugins) {
        for (const key of ['clipboardTextSerializer', 'transformCopied']) {
          const original = plugin.props[key];
          if (original) plugin.props[key] = function (...args) { const t = performance.now(); try { return original.apply(this,args); } finally { stages[key] = (stages[key] ?? 0)+performance.now()-t; } };
        }
      }
      const data = new DataTransfer();
      const copyStart = performance.now();
      editor.view.dom.dispatchEvent(new ClipboardEvent('copy', {clipboardData:data, bubbles:true, cancelable:true}));
      const copy = performance.now() - copyStart;
      const plain = data.getData('text/plain'), html = data.getData('text/html');
      return {selection, copy, crossedSection, stages, selectionPlugins, inSectionCommits, plainLength:plain.length, htmlLength:html.length, complete:plain.includes('Section 999') && plain.includes('value') && html.includes('<table') && html.includes('<img') && html.includes('inline-math')};
    });
    if (session) {
      const {profile} = await session.send('Profiler.stop');
      const counts = new Map();
      for (const id of profile.samples ?? []) counts.set(id,(counts.get(id) ?? 0)+1);
      console.log('CPU self samples', profile.nodes.map(n=>({name:n.callFrame.functionName, url:n.callFrame.url, samples:counts.get(n.id) ?? 0})).sort((a,b)=>b.samples-a.samples).slice(0,20));
    }
    console.log(JSON.stringify({stats, ...samples}));
    assert.ok(samples.crossedSection, 'TOC follows cursor into the final root section');
    assert.ok(samples.complete, 'real clipboard event serializes the entire note and tables');
    assert.ok(samples.copy < 3000, `copy blocked for ${samples.copy}ms`);
    assert.ok(samples.selection < 3000, `select-all blocked for ${samples.selection}ms`);
    assert.equal(samples.inSectionCommits, 0, 'TOC must not commit for cursor moves within a root section');
  } finally { await browser?.close(); await server.close(); }
});
