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

test('sidebar creates, renames, collapses and deletes folders while preserving modules and reloads order', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => window.installTestBridge({ tauri: { invoke: async (command, args) => {
    const items = JSON.parse(localStorage.getItem('sidebar') ?? '[]');
    if (command === 'sidebar_items') return items;
    if (command === 'save_sidebar_items') {
      for (const item of args.items) {
        const index = items.findIndex(entry => entry.id === item.id);
        if (index < 0) items.push(item); else items[index] = item;
      }
      localStorage.setItem('sidebar', JSON.stringify(items));
      return null;
    }
    return [];
  } } }));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]'));
  const row = id => page.locator(`[data-sidebar-item="${id}"]`).first();
  // Wait for the re-rendered list, not just the saved state, before measuring rows again.
  const inFolder = (id, inside) => page.waitForFunction(([id, inside]) =>
    !!document.querySelector(`[role=group] [data-sidebar-item="${id}"]`) === inside, [id, inside]);
  // Rows have no drag handle: the whole row is dragged once the pointer moves.
  const drag = async (from, to) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + 40, a.y + 12); await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 12, { steps: 15 }); await page.mouse.up();
  };
  const moduleOrder = () => page.locator('[data-sidebar-item]').evaluateAll(rows => rows.map(row => row.dataset.sidebarItem).filter(id => !id.startsWith('folder-')));
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    await row('0').waitFor();
    assert.equal(await page.getByText('Move to top level').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Move / }).count(), 0, 'no drag handles');
    await drag(row('1'), row('0'));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]').some(item => item.id === '1' && item.sort_order === 0));
    await page.reload();
    await row('0').waitFor();
    assert.deepEqual(await moduleOrder(), ['1', '0', '2']);
    await page.locator('.group').first().hover();
    await page.getByRole('button', { name: 'Add module', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
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
    assert.equal((await stored()).filter(item => item.name && item.deleted).length, 1);
  } finally { await page.close(); }
});
