import { browserHarness } from "./support/browser.mjs";
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { fileURLToPath } from 'node:url';

const { createServer, webkit } = browserHarness(import.meta.url);

let browser, server;
before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen(); browser = await webkit.launch();
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(folder, viewport = { width: 900, height: 800 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  await page.exposeFunction('pickFolder', () => folder);
  await page.addInitScript(() => { window.installTestBridge({ tauri: { invoke: command => command === 'pick_import_folder' ? window.pickFolder() : Promise.resolve([]) } }); });
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/import-dialog.html`);
  await page.getByRole('region', { name: 'Module actions' }).hover();
  await page.getByRole('button', { name: 'Add module', exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('memnoter-import-folder')));
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  return page;
}
const order = page => page.getByRole('list', { name: 'Notes to import' }).getByRole('checkbox').evaluateAll(inputs => inputs.map(input => input.labels[0].textContent));
async function aligned(page) {
  const errors = await page.getByRole('dialog').getByRole('checkbox').evaluateAll(inputs => inputs.map(input => {
    const box = input.getBoundingClientRect(), label = input.labels[0];
    const text = label.getBoundingClientRect(), line = parseFloat(getComputedStyle(label).lineHeight);
    return Math.abs(box.top + box.height / 2 - text.top - line / 2);
  }));
  assert.ok(errors.every(error => error < 1), `checkbox alignment: ${errors}`);
}
// Browser boundary owns interaction and layout: model tests cannot catch clipped
// help, broken pointer capture, lost keyboard focus or a checkbox above its label.
test('compact list supports whole-row pointer drag, keyboard drop/cancel and aligned wrapping labels', async () => {
  const page = await open({ name: 'Vault', entries: ['a.md', 'b.md', 'Group/c.md'].map(path => ({ path, text: 'Note' })) }, { width: 420, height: 700 });
  try {
    assert.deepEqual(await order(page), ['a', 'b', 'c']);
    await aligned(page);
    const list = page.getByRole('list', { name: 'Notes to import' });
    const help = await page.getByText('Drag to reorder, including between folders.', { exact: false }).boundingBox();
    assert.ok(help.y + help.height <= (await list.boundingBox()).y);
    const rows = list.getByRole('listitem');
    const source = await rows.nth(1).boundingBox(), target = await rows.first().boundingBox();
    await page.mouse.move(source.x + source.width - 30, source.y + source.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + target.width - 30, target.y + 4, { steps: 12 });
    await page.waitForFunction(bounds => {
      const input = [...document.querySelectorAll('input[type="checkbox"]')].find(input => input.labels?.[0]?.textContent === 'a');
      return input && input.getBoundingClientRect().top > bounds.y + bounds.height / 2;
    }, target);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const list = document.querySelector('[aria-label="Notes to import"]');
      return JSON.stringify([...list.querySelectorAll('input')].map(input => input.labels[0].textContent)) === JSON.stringify(['b', 'a', 'c']);
    });
    assert.deepEqual(await order(page), ['b', 'a', 'c']);
    const handle = page.getByRole('button', { name: 'Reorder c', exact: true });
    await handle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowUp');
    assert.deepEqual(await order(page), ['b', 'c', 'a']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await order(page), ['b', 'a', 'c']);
    assert.equal(await page.getByRole('dialog').count(), 1);
    await handle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Space');
    assert.deepEqual(await order(page), ['c', 'b', 'a']);
    await page.getByText('Dropped c. Position 1 of 3.', { exact: true }).waitFor();
  } finally { await page.close(); }
});

for (const { text, images, summary, issue } of [
  { text: '', images: [], summary: "These notes don't reference any images." },
  { text: '![[a.png]]', images: ['a.png'], summary: '1 image found.' },
  { text: '![[a.png]] ![[b.png]]', images: ['a.png', 'b.png'], summary: 'All 2 images found.' },
  { text: '![[a.png]]', images: [], summary: '0 of 1 image found. 1 is missing.' },
  { text: '![[a.png]] ![[b.png]] ![[c.png]]', images: ['a.png'], summary: '1 of 3 images found. 2 are missing.' },
  { text: '![[a.png]]', images: ['one/a.png', 'two/a.png'], summary: '0 of 1 image found. 1 is missing.', issue: "Several files are named a.png: couldn't tell which one to use." },
]) {
  test(`image step: ${summary}${issue ? ' (ambiguous)' : ''}`, async () => {
    const page = await open({ name: 'Vault', entries: [{ path: 'note.md', text }, ...images.map(path => ({ path }))] });
    try {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText(summary, { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Look in another folder…' }).count(), text ? 1 : 0);
      if (issue) await page.getByText(issue, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByText('1 note will be imported. Missing images will show as placeholders.').waitFor();
    } finally { await page.close(); }
  });
}

// A short list cannot expose regressions in edge scrolling or its cleanup.
test('drag auto-scrolls a long list, cancels without changing order, and honors reduced motion', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `Note ${String(i).padStart(2, '0')} with a long title that should truncate.md`);
  const page = await open({ name: 'Vault', entries: names.map(path => ({ path, text: '' })) }, { width: 420, height: 700 });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const list = page.getByRole('list', { name: 'Notes to import' });
    assert.equal(await list.locator('li').first().evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    const name = list.locator('label span').first();
    assert.equal(await name.getAttribute('title'), names[0]);
    assert.ok(await name.evaluate(el => el.scrollWidth > el.clientWidth));
    const row = await list.locator('li > div').first().boundingBox(), bounds = await list.boundingBox();
    await page.mouse.move(row.x + row.width - 20, row.y + 18); await page.mouse.down();
    await page.mouse.move(row.x + row.width - 20, bounds.y + bounds.height - 4, { steps: 10 });
    await page.waitForFunction(() => document.querySelector('[aria-label="Notes to import"]').scrollTop > 80);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await order(page), names.map(name => name.replace(/\.md$/, '')));
    const afterCancel = await list.evaluate(el => el.scrollTop);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await list.evaluate(el => el.scrollTop), afterCancel);
  } finally { await page.close(); }
});
