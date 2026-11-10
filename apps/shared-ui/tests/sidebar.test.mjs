import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { browserHarness } from './support/browser.mjs';
const { createServer, webkit } = browserHarness(import.meta.url);
let browser, server;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  browser = await webkit.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

// Hold saves explicitly when testing the optimistic layout before persistence.
const useSidebarStore = (page, seed = [], holdSaves = false) => page.addInitScript(([seed, holdSaves]) => {
  if (localStorage.getItem('sidebar') === null && seed.length) localStorage.setItem('sidebar', JSON.stringify(seed));
  window.installTestBridge({ tauri: { invoke: async (command, args) => {
    const items = JSON.parse(localStorage.getItem('sidebar') ?? '[]');
    if (command === 'sidebar_items') return items;
    if (command === 'save_sidebar_items') {
      if (holdSaves) await new Promise(resolve => { window.releaseSidebarSave = resolve; });
      for (const item of args.items) {
        const index = items.findIndex(entry => entry.id === item.id);
        if (index < 0) items.push(item); else items[index] = item;
      }
      localStorage.setItem('sidebar', JSON.stringify(items));
      return null;
    }
    return [];
  } } });
}, [seed, holdSaves]);

test('sidebar creates, renames, collapses and deletes folders while preserving modules and reloads order', async () => {
  const page = await browser.newPage();
  await useSidebarStore(page);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]'));
  const row = id => page.locator(`[data-sidebar-item="${id}"]`).first();
  // Wait for the re-rendered list, not just the saved state, before measuring rows again.
  const inFolder = (id, inside) => page.waitForFunction(([id, inside]) =>
    !!document.querySelector(`[role=group] [data-sidebar-item="${id}"]`) === inside, [id, inside]);
  // Rows have no drag handle: the whole row is dragged once the pointer moves.
  const drag = async (from, to) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.move(a.x + 40, a.y + 12); await page.mouse.down();
    // Let the sensor activate and the drop targets be measured before moving on, and settle before dropping.
    await page.mouse.move(a.x + 40, a.y + 24, { steps: 3 }); await frames();
    await page.mouse.move(b.x + 40, b.y + 12, { steps: 15 }); await frames(); await page.mouse.up();
  };
  const moduleOrder = () => page.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.dataset.sidebarItem).filter(id => !id.startsWith('folder-')));
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    await row('0').waitFor();
    assert.equal(await page.getByText('Move to top level').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Move / }).count(), 0, 'no drag handles');
    await page.locator('.group').first().hover();
    await page.getByRole('button', { name: 'Add module', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('First folder');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.reload();
    await row('0').waitFor();
    assert.deepEqual(await page.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.textContent)), ['Algebra', 'Biology', 'Chemistry', 'First folder']);
    await page.getByRole('button', { name: 'Actions for First folder', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder (keep modules)', exact: true }).click();
    await page.getByRole('button', { name: 'First folder', exact: true }).waitFor({ state: 'hidden' });
    await drag(row('1'), row('0'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]').some(item => item.id === '1' && item.sort_order === 0));
    await page.reload();
    await row('0').waitFor();
    assert.deepEqual(await moduleOrder(), ['1', '0', '2']);
    await page.locator('.group').first().hover();
    await page.getByRole('button', { name: 'Add module', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    // The field is set apart from the title, as in the new-module dialog.
    const [titleBox, labelBox] = await Promise.all([page.getByRole('heading', { name: 'New folder', exact: true }).boundingBox(), page.getByText('Name', { exact: true }).boundingBox()]);
    assert.ok(labelBox.y - (titleBox.y + titleBox.height) >= 8, `label sits clear of the title: ${labelBox.y - (titleBox.y + titleBox.height)}px`);
    await page.getByLabel('Name', { exact: true }).fill('Study');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const folder = page.getByRole('button', { name: 'Study', exact: true });
    await folder.waitFor();
    // Folder rows use the sidebar row: full width, with the actions button at the right edge.
    const [folderBox, rowBox, actionsBox] = await Promise.all([folder.boundingBox(), row('0').boundingBox(), page.getByRole('button', { name: 'Actions for Study', exact: true }).boundingBox()]);
    assert.ok(folderBox.width > rowBox.width * 0.9, 'folder button spans the row');
    assert.ok(actionsBox.x + actionsBox.width > rowBox.x + rowBox.width - 12, 'actions button sits at the right edge');
    await drag(row('0'), folder);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id));
    await inFolder('0', true);
    // Out of the folder: drop onto a top-level module.
    await drag(row('0'), row('2'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id === null));
    await inFolder('0', false);
    await drag(row('0'), folder);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id));
    await inFolder('0', true);
    // dnd-kit keeps its document click guard for 50ms after a drop. A normal
    // pointer press lets that cleanup finish before this separate click.
    await folder.click({ delay: 60 });
    await page.getByRole('button', { name: 'Study', exact: true, expanded: false }).waitFor();
    assert.equal(await row('0').count(), 0);
    await page.getByRole('button', { name: 'Actions for Study', exact: true }).click({ force: true });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Science');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Actions for Science', exact: true }).click({ force: true });
    await page.getByRole('menuitem', { name: 'Delete folder (keep modules)', exact: true }).click();
    await row('0').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Science', exact: true }).count(), 0);
    assert.equal((await stored()).filter(item => item.name && item.deleted).length, 2);
  } finally { await page.close(); }
});

test('a dragged module is previewed under the pointer, also while over a folder', async () => {
  const page = await browser.newPage();
  await useSidebarStore(page, [{ id: 'folder-study', name: 'Study', folder_id: null, sort_order: 0, collapsed: false, deleted: false }]);
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    const row = page.locator('[data-sidebar-item="1"]').first();
    await row.waitFor();
    const folder = page.getByRole('button', { name: 'Study', exact: true });
    const [from, over] = await Promise.all([row.boundingBox(), folder.boundingBox()]);
    const preview = page.locator('[data-sidebar-drag-preview]');
    assert.equal(await preview.count(), 0, 'no preview before dragging');
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(over.x + 40, over.y + over.height / 2, { steps: 15 });
    // A folder is not a slot in the list, so the row cannot preview by moving there:
    // a copy of it follows the pointer instead.
    await preview.waitFor({ timeout: 3000 });
    const box = await preview.boundingBox();
    assert.ok(Math.abs(box.y + box.height / 2 - (over.y + over.height / 2)) < 20, `the preview is under the pointer: ${box.y} vs ${over.y}`);
    assert.ok(Math.abs(box.width - from.width) < 4, 'the preview is as wide as the row');
    assert.ok((await preview.innerText()).includes(await row.innerText()), 'the preview shows the module');
    await page.mouse.up();
    await preview.waitFor({ state: 'detached', timeout: 3000 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '1' && item.folder_id === 'folder-study'));
  } finally { await page.close(); }
});

test('a reordered row stays where it was dropped while the change is still being saved', async () => {
  const page = await browser.newPage();
  // Keep the save pending until the optimistic layout has been observed.
  await useSidebarStore(page, [], true);
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    const row = id => page.locator(`[data-sidebar-item="${id}"]`).first();
    await row('0').waitFor();
    const order = () => page.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.dataset.sidebarItem));
    assert.deepEqual(await order(), ['0', '1', '2']);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const [from, over] = await Promise.all([row('2').boundingBox(), row('0').boundingBox()]);
    await page.mouse.move(from.x + 40, from.y + 12); await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y - 4, { steps: 3 }); await frames();
    await page.mouse.move(over.x + 40, over.y + 6, { steps: 15 }); await frames();
    // Record the row order on every frame from here on, so a single frame in the old order shows.
    await page.evaluate(() => {
      window.frameOrders = [];
      const record = () => {
        window.frameOrders.push({ dragging: !!document.querySelector('[data-sidebar-drag-preview]'), order: [...document.querySelectorAll('[data-sidebar-item]')].map(row => row.dataset.sidebarItem).join() });
        requestAnimationFrame(record);
      };
      record();
    });
    await page.mouse.up();
    await page.waitForFunction(() => window.releaseSidebarSave && window.frameOrders.filter(frame => !frame.dragging).length > 5);
    // After the drop (the save is still running) the rows are already in their new order, in every frame.
    const afterDrop = (await page.evaluate(() => window.frameOrders)).filter(frame => !frame.dragging);
    assert.ok(afterDrop.length > 5, 'frames were recorded after the drop');
    assert.deepEqual([...new Set(afterDrop.map(frame => frame.order))], ['2,0,1'], 'rows never fall back to the old order');
    assert.equal(await page.evaluate(() => localStorage.getItem('sidebar')), null, 'save remains pending during the frame assertions');
    await page.evaluate(() => window.releaseSidebarSave());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]').some(item => item.id === '2' && item.sort_order === 0), null, { timeout: 5000 });
    assert.deepEqual(await order(), ['2', '0', '1'], 'and stays so once saved');
  } finally { await page.close(); }
});

test('reordering inside a folder previews the row and never flashes the folder grey', async () => {
  const page = await browser.newPage();
  const module = (id, order) => ({ id, name: null, folder_id: 'folder-study', sort_order: order, collapsed: false, deleted: false });
  await useSidebarStore(page, [{ id: 'folder-study', name: 'Study', folder_id: null, sort_order: 0, collapsed: false, deleted: false }, module('0', 1), module('1', 2)]);
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    const group = page.getByRole('group', { name: 'Study' });
    const row = id => group.locator(`[data-sidebar-item="${id}"]`);
    await row('1').waitFor();
    const order = () => group.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.dataset.sidebarItem));
    assert.deepEqual(await order(), ['0', '1']);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const [from, over] = await Promise.all([row('1').boundingBox(), row('0').boundingBox()]);
    // Every frame: is a preview shown, and is the folder body (the zone around its rows) painted?
    await page.evaluate(() => {
      window.recorded = [];
      const record = () => {
        const body = document.querySelector('[role=group][aria-label=Study]').parentElement;
        window.recorded.push({ preview: !!document.querySelector('[data-sidebar-drag-preview]'), grey: getComputedStyle(body).backgroundColor !== 'rgba(0, 0, 0, 0)' });
        requestAnimationFrame(record);
      };
      record();
    });
    // Move like a hand: small steps, a frame between each, across the rows and the gap between them.
    let at = { x: from.x + 40, y: from.y + from.height / 2 };
    const glide = async (y, steps) => {
      const start = at.y;
      for (let step = 1; step <= steps; step++) { at = { x: at.x, y: start + (y - start) * step / steps }; await page.mouse.move(at.x, at.y); await frames(); }
    };
    await page.mouse.move(at.x, at.y); await page.mouse.down();
    await glide(from.y + 2, 4);
    await glide(over.y + over.height / 2, 30);
    await glide(over.y + 2, 8);
    const during = await page.evaluate(() => window.recorded.filter(frame => frame.preview));
    assert.ok(during.length > 10, 'a preview follows the pointer while reordering inside the folder');
    assert.equal(during.filter(frame => frame.grey).length, 0, 'the folder body is never painted grey while reordering inside it');
    await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).find(item => item.id === '1').sort_order < JSON.parse(localStorage.getItem('sidebar')).find(item => item.id === '0').sort_order);
    assert.deepEqual(await order(), ['1', '0']);
  } finally { await page.close(); }
});

test('letting go of a row inside its own folder, away from other rows, does not move it', async () => {
  const page = await browser.newPage();
  const module = (id, order) => ({ id, name: null, folder_id: 'folder-study', sort_order: order, collapsed: false, deleted: false });
  await useSidebarStore(page, [{ id: 'folder-study', name: 'Study', folder_id: null, sort_order: 0, collapsed: false, deleted: false }, module('0', 1), module('1', 2), module('2', 3)]);
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    const group = page.getByRole('group', { name: 'Study' });
    const first = group.locator('[data-sidebar-item="0"]');
    await first.waitFor();
    const order = () => group.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.dataset.sidebarItem));
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await first.boundingBox();
    // Pick the row up and put it down again on its own slot.
    await page.mouse.move(box.x + 40, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2 + 8, { steps: 4 }); await frames();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 4 }); await frames();
    await page.mouse.up();
    await frames();
    await page.waitForFunction(() => !document.querySelector('[data-sidebar-drag-preview]'));
    assert.deepEqual(await order(), ['0', '1', '2']);
    assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('sidebar'))).every(item => item.id !== '0' || item.sort_order === 1), 'nothing was reordered in storage');
  } finally { await page.close(); }
});
