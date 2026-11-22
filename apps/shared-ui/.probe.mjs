import { chromium } from 'playwright';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const ctx = await chromium.launchPersistentContext(process.argv[2], { headless: true, userAgent: UA, viewport: null, args: ['--window-size=1400,900'] });
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  let cb = 0; const fns = new Map(), outbox = new Set(); let nudge; const B = 'http://127.0.0.1:8788';
  const core = async (command, args) => {
    const r = await fetch(B + '/core', { method: 'POST', body: JSON.stringify({ command, args: args ?? {} }) });
    const t = await r.text(); if (!r.ok) throw t; return t ? JSON.parse(t) : null;
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: fn => { const id = ++cb; fns.set(id, fn); return id; }, unregisterCallback: id => fns.delete(id),
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    convertFileSrc: p => B + '/files/' + encodeURIComponent(String(p).replace(/\\/g, '/').split('/').pop()),
    invoke: async (command, args) => {
      if (command === 'core') {
        const c = args.command, a = args.args ?? {};
        if (c === 'sync_credentials_save') { localStorage.setItem('bridge-sync-account', JSON.stringify(a.account)); return null; }
        if (c === 'sync_credentials_load') { const v = localStorage.getItem('bridge-sync-account'); return v ? JSON.parse(v) : null; }
        if (c === 'sync_credentials_delete') { localStorage.removeItem('bridge-sync-account'); return null; }
        const out = await core(c, a);
        if (!c.startsWith('sync_') && outbox.size) { clearTimeout(nudge); nudge = setTimeout(() => outbox.forEach(id => fns.get(id)?.({ event: 'sync-outbox', id, payload: null })), 300); }
        return out;
      }
      if (command === 'pick_pdfs') {
        const files = await new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/pdf'; i.multiple = true; i.onchange = () => res([...i.files]); i.oncancel = () => res([]); i.click(); });
        const out = [];
        for (const f of files) { try { out.push({ Ok: await core('add_document_bytes', { moduleId: args.moduleId, name: f.name, bytes: [...new Uint8Array(await f.arrayBuffer())] }) }); } catch (e) { out.push({ Err: String(e) }); } }
        return out;
      }
      if (command === 'plugin:event|listen' && args?.event === 'sync-outbox') { outbox.add(args.handler); return args.handler; }
      if (command === 'plugin:event|unlisten') { outbox.delete(args?.eventId); return null; }
      if (command.startsWith('plugin:')) { console.debug('[bridge] shell', command); return command.includes('listen') ? ++cb : null; }
      console.debug('[bridge] shell', command, args); return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
});
const page = ctx.pages()[0] ?? await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
for (const url of ['http://localhost:1420/questions','http://localhost:1420/questions?module=14625077-db1a-4434-b03a-cbaef2d3b6b2']) {
  await page.goto(url); await page.waitForTimeout(3000);
  console.log(url, JSON.stringify(await page.evaluate(() => ({ hint: [...document.querySelectorAll('p')].filter(p => p.textContent.includes('to add questions')).map(p => getComputedStyle(p).display + ':' + p.className), states: [...document.querySelectorAll('[data-bank-state]')].map(e => e.getAttribute('data-bank-state')), qs: [...document.querySelectorAll('.questions-module')].map(s => s.children.length + ':' + s.innerHTML.slice(0,300)), rule: [...document.styleSheets].some(sh => { try { return [...sh.cssRules].some(r => r.cssText.includes('questions-all-empty')); } catch { return false; } }) }))));
}
await ctx.close();
