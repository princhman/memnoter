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
  try {
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/sidebar.html`);
    await page.getByRole('button', { name: 'Move Algebra', exact: true }).waitFor();
    const handle = page.getByRole('button', { name: 'Move Biology', exact: true });
    await handle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Space');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar') ?? '[]').some(item => item.id === '1' && item.sort_order === 0));
    await page.reload();
    assert.deepEqual(await page.getByRole('button', { name: /^Move (Algebra|Biology|Chemistry)$/ }).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Move Biology', 'Move Algebra', 'Move Chemistry']);
    await page.locator('.group').first().hover();
    await page.getByRole('button', { name: 'Add module', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Study');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Study', exact: true }).waitFor();
    // Pointer dragging exercises folder drop targets, beyond pure order tests.
    const from = await page.getByRole('button', { name: 'Move Algebra', exact: true }).boundingBox();
    const to = await page.getByRole('button', { name: 'Study', exact: true }).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id));
    await page.waitForFunction(() => !document.querySelector('[aria-label="Move Algebra"]').disabled);
    await page.getByRole('button', { name: 'Move Algebra', exact: true }).click({ trial: true });
    const inside = await page.getByRole('button', { name: 'Move Algebra', exact: true }).boundingBox();
    const rootTarget = await page.getByText('Move to top level', { exact: true }).boundingBox();
    await page.mouse.move(inside.x + inside.width / 2, inside.y + inside.height / 2); await page.mouse.down();
    await page.mouse.move(rootTarget.x + rootTarget.width / 2, rootTarget.y + rootTarget.height / 2, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id === null));
    await page.waitForFunction(() => !document.querySelector('[aria-label="Move Algebra"]').disabled);
    await page.getByRole('button', { name: 'Move Algebra', exact: true }).click({ trial: true });
    const outside = await page.getByRole('button', { name: 'Move Algebra', exact: true }).boundingBox();
    const folderTarget = await page.getByRole('button', { name: 'Study', exact: true }).boundingBox();
    await page.mouse.move(outside.x + outside.width / 2, outside.y + outside.height / 2); await page.mouse.down();
    await page.mouse.move(folderTarget.x + folderTarget.width / 2, folderTarget.y + folderTarget.height / 2, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('sidebar')).some(item => item.id === '0' && item.folder_id));
    await page.getByRole('button', { name: 'Study', exact: true }).click({ trial: true });
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await page.getByRole('button', { name: 'Study', exact: true, expanded: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Move Algebra', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Actions for Study', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Science');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for Science', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder (keep modules)', exact: true }).click();
    await page.getByRole('button', { name: 'Move Algebra', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Science', exact: true }).count(), 0);
    assert.equal((await stored()).filter(item => item.name && item.deleted).length, 1);
  } finally { await page.close(); }
});
