import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { webkit } from 'playwright';
import { measureContrast } from './helpers-contrast.mjs';

// Protects readable rendered text through token, utility and state changes. Existing
// editor tests check selection/schema, but do not measure the colors WebKit paints.
test('light and dark rendered UI contrast', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cacheDir = await mkdtemp(join(root, 'node_modules/.contrast-vite-'));
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  const recipes = [];
  async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else if (path.endsWith('.tsx')) {
        const source = await readFile(path, 'utf8');
        // Extract actual color utility recipes, including variants stored in cva/maps.
        for (const match of source.matchAll(/["`]([^"`\n]+)["`]/g)) {
          const tokens = match[1].split(/\s+/).filter(t => /^(?:(?:dark|hover|focus|focus-visible):)*(?:text|bg|opacity)-/.test(t) && !t.includes('${'));
          if (tokens.some(t => /text-(?:muted|primary|destructive|sidebar|red|amber|emerald|sky|chart|foreground|background|secondary|popover)/.test(t))) recipes.push({ path: path.slice(root.length), tokens });
        }
      }
    }
  }
  await inventory(join(root, 'src'));
  const report = [];
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contrast.html`);
    await page.waitForFunction(() => window.contrastReady);
    for (const dark of [false, true]) {
      await page.evaluate(({ dark, recipes }) => {
        document.documentElement.classList.toggle('dark', dark);
        const audit = document.querySelector('#audit'); audit.innerHTML = '';
        if (!document.querySelector('#audit-states')) {
          const style = document.createElement('style'); style.id = 'audit-states';
          style.textContent = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join('\n')
            .replaceAll(':hover', '.audit-hover').replaceAll(':focus-visible', '.audit-focus-visible').replaceAll(':focus', '.audit-focus');
          document.head.append(style);
        }
        const add = (label, html, classes = '') => {
          const row = document.createElement('section'); row.dataset.audit = label; row.className = classes;
          row.innerHTML = html; audit.append(row);
        };
        for (const surface of ['background', 'muted', 'accent', 'popover', 'sidebar', 'secondary', 'card']) {
          const base = `bg-${surface} text-${surface === 'background' ? 'foreground' : surface + '-foreground'} text-sm`;
          add(`${surface} body`, 'Body text', base);
          add(`${surface} link`, '<a href="#" style="color:var(--link)">Link</a>', base);
          for (const color of ['yellow', 'green', 'blue', 'pink', 'purple']) add(`${surface} highlight ${color} link`, `<mark class="note-highlight" data-color="${color}"><a href="#">Link</a></mark>`, `${base} tiptap`);
          add(`${surface} muted`, '<span class="text-muted-foreground">Caption, timestamp, placeholder, empty state</span>', base);
          for (const { path, tokens } of recipes) for (const state of ['', 'hover', 'focus', 'focus-visible']) {
            add(`${path} ${surface} ${state} ${tokens.join(' ')}`, `<span class="${tokens.join(' ')} audit-${state}">Readable interface</span>`, base);
          }
        }
        const variants = ['plain', 'strong', 'code', 'link', 'math', 'muted'];
        for (const color of ['yellow', 'green', 'blue', 'pink', 'purple'])
          for (const context of ['p', 'h1', 'h3', 'h5', 'th', 'td', 'li', 'blockquote', 'cloze-text', 'card-face', 'callout'])
            for (const selected of [false, true, 'outside', ...(['td', 'th'].includes(context) ? ['cell'] : [])]) for (const variant of variants) {
              const content = variant === 'strong' ? '<strong>Bold</strong>' : variant === 'code' ? '<code>Code</code>' : variant === 'link' ? '<a href="#">Link</a>' : variant === 'math' ? '<span class="inline-math-widget"><span class="katex">x²</span></span>' : variant === 'muted' ? '<span class="heading-number">1.2</span>' : 'Text';
              let html = `<mark class="note-highlight" data-color="${color}">${selected === true ? `<span class="text-range-selected">${content}</span>` : content}</mark>`;
              if (selected === 'outside') html = `<span class="text-range-selected">${html}</span>`;
              if (context === 'th' || context === 'td') html = `<table><tr><${context} class="${selected === 'cell' ? 'selectedCell' : ''}">${html}</${context}></tr></table>`;
              else if (context === 'li') html = `<ul><li>${html}</li></ul>`;
              else if (['cloze-text', 'card-face', 'callout'].includes(context)) html = `<div class="${context}">${html}</div>`;
              else html = `<${context}>${html}</${context}>`;
              add(`highlight ${color} ${context} ${variant} ${selected === 'cell' ? 'cell selection' : selected === 'outside' ? 'outer selection' : selected ? 'selected' : ''}`, html, 'tiptap');
            }
        for (const cls of ['toc-item', 'toc-item-active', 'toc-item-related']) add(cls, `<button class="toc-item" data-active="${cls.endsWith('active')}" data-related="${cls.endsWith('related')}">Contents title</button>`, 'toc-popup');
        for (const cls of ['occlusion-number', 'occlusion-number is-selected', 'card-info-state', 'card-sep']) add(cls, `<div class="card-block-active"><span class="${cls}">12</span></div>`, cls === 'card-sep' ? 'tiptap card-block-active' : 'tiptap');
        for (const state of ['new', 'learning', 'review']) add(`badge ${state}`, `<span class="card-info-state" data-state="${state}">Status</span>`, 'tiptap bg-popover');
        add('code block', '<pre><code>const answer = "plain syntax; no token stylesheet installed";</code></pre>', 'tiptap');
        add('math selected', '<span class="inline-math-widget is-selected">x²</span>', 'tiptap');
        // WCAG 1.4.11 does not require 3:1 decorative dividers or control outlines
        // when controls are identifiable otherwise (fill/label); retain state indicators.
        for (const surface of ['background', 'accent', 'popover', 'sidebar']) for (const token of ['ring', 'control-accent']) add(`nontext ${token} ${surface}`, `<i data-audit="${token} ${surface}" data-audit-nontext="color" style="color:var(--${token})"> </i>`, `bg-${surface}`);
        for (const state of ['', 'true', 'related']) add(`rail ${state}`, `<div class="toc-dash" data-active="${state}" data-related="${state === 'related'}"><span data-audit="rail ${state}" data-audit-nontext="backgroundColor"></span></div>`);
        for (const cls of ['find-highlight', 'find-highlight find-highlight-current']) add(`search ${cls}`, `<span class="${cls}" style="position:static">Search match</span>`);
        for (const cls of ['toc-item', 'toc-item audit-hover', 'toc-item audit-focus-visible']) add(`contents ${cls}`, `<button class="${cls}" data-active="true">Active contents item</button>`, 'toc-popup');
        add('disabled control', '<button disabled style="opacity:.5">Unavailable action</button>');
        add('placeholder', '<input data-audit-placeholder="input placeholder" class="bg-input/30 placeholder:text-muted-foreground" placeholder="Search" />');
        // Positioning is irrelevant to contrast; keep popup specimens in normal flow.
        audit.querySelectorAll('.toc-popup,.occlusion-number').forEach(el => { el.style.position = 'static'; });
      }, { dark, recipes });
      await page.evaluate(() => window.renderContrastControls());
      await page.evaluate(() => document.fonts.ready);
      const pairs = await page.evaluate(measureContrast);
      assert.ok(pairs.length > 1000, 'fixture must render the full inventory');
      report.push(...pairs.map(pair => ({ theme: dark ? 'dark' : 'light', ...pair })));
    }
    // Exercise the actual editor DOM and its selection decorations, not only
    // synthetic combinations: node views/KaTeX can add their own ink and fills.
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/selection.html`);
    await page.waitForFunction(() => window.editor);
    await page.evaluate(() => {
      const colors = ['yellow', 'green', 'blue', 'pink', 'purple'];
      editor.commands.setContent(colors.map(color => `<h3><mark data-color="${color}">Heading</mark></h3><p><mark data-color="${color}">Normal <strong>bold</strong> <code>code</code> <a href="https://example.com">link</a></mark></p>`).join(''));
      editor.commands.insertContent({ type: 'paragraph', content: [{ type: 'inlineMath', marks: [{ type: 'highlight', attrs: { color: 'blue' } }], content: [{ type: 'text', text: 'x^2' }] }] });
    });
    for (const dark of [false, true]) for (const selected of [false, true]) {
      await page.evaluate(({ dark, selected }) => {
        document.documentElement.classList.toggle('dark', dark);
        if (selected) editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
        else editor.commands.setTextSelection(1);
      }, { dark, selected });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const pairs = await page.evaluate(measureContrast, '#root');
      assert.ok(pairs.length > 20, 'real editor content must be measured');
      report.push(...pairs.map(pair => ({ ...pair, theme: dark ? 'dark' : 'light', label: `editor ${selected ? 'selected' : ''} ${pair.label}` })));
    }
    if (process.env.CONTRAST_REPORT) await writeFile(process.env.CONTRAST_REPORT, JSON.stringify(report, null, 2));
    const failures = report.filter(p => p.ratio + .005 < p.minimum);
    assert.equal(failures.length, 0, `${failures.length} contrast failures:\n${failures.slice(0, 65).map(p => `${p.theme} ${p.label}: ${p.ratio.toFixed(2)} < ${p.minimum} (${p.foreground} on ${p.background})`).join('\n')}`);
  } finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
