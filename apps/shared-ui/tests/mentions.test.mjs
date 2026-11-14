import { textPdfBytes } from "./browser/pdf-text-selection-pdf.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { extractMentions, backlinks } from '../src/lib/mention-index.ts';
import { browserHarness } from './support/browser.mjs';
const target = { kind: 'heading', id: 'm2', nodeId: 'stable-heading', locator: null };
test('backlinks track the exact node and source location, and disappear on deletion', () => {
  const doc = { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Source section' }] }, { type: 'mention', attrs: { target, mentionId: 'link-1' } }] };
  const notes = [{ id: 'm1', name: 'Source', note: extractMentions(doc) }];
  assert.deepEqual(backlinks(notes, target).map(x => [x.moduleId, x.mentionId, x.heading]), [['m1', 'link-1', 'Source section']]);
  assert.equal(backlinks(notes, { ...target, nodeId: 'other' }).length, 0);
  assert.equal(backlinks(notes, { ...target, kind: 'module', nodeId: null }).length, 0);
  doc.content.pop(); assert.equal(backlinks([{ ...notes[0], note: extractMentions(doc) }], target).length, 0);
});
function seed(blocks) {
  const doc = new Y.Doc();
  for (const [type, text, attrs = {}] of blocks) {
    const node = new Y.XmlElement(type); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    const content = new Y.XmlText(); content.insert(0, text); node.insert(0, [content]); doc.getXmlFragment('default').push([node]);
  }
  const bytes = Array.from(Y.encodeStateAsUpdate(doc)); doc.destroy(); return bytes;
}
const { createServer, webkit } = browserHarness(import.meta.url);
test('WebKit: insert, round-trip, navigate, rename and jump back to an exact mention', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' }); let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', error => console.error('PAGE:', error.message));
    await page.addInitScript(({ source, destination }) => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      const data = JSON.parse(localStorage.getItem('mention-fixture') ?? 'null') ?? { modules: [{ id: 'm1', name: 'Research', heading_numbering: false }, { id: 'm2', name: 'Biology', heading_numbering: false }], contents: { m1: { state: source, updates: [], files: [] }, m2: { state: destination, updates: [], files: [] } } };
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith('plugin:')) return 1;
        if (command === 'document_path') return '/mention-guide.pdf';
        if (command === 'modules') return data.modules;
        if (command === 'get_content') return structuredClone(data.contents[args.moduleId]);
        if (command === 'add_update') { const update = { id: Date.now(), bytes: args.bytes }; data.contents[args.moduleId].updates.push(update); localStorage.setItem('mention-fixture', JSON.stringify(data)); return update; }
        if (command === 'rename_module') { data.modules.find(x => x.id === args.moduleId).name = args.name; localStorage.setItem('mention-fixture', JSON.stringify(data)); return; }
        if (command === 'list_documents') return [{ id: 'pdf1', moduleId: 'm2', moduleName: 'Biology', name: 'Field guide.pdf', size: 1, pageCount: 1, available: true }];
        return [];
      } } });
    }, { source: seed([['paragraph', 'See ']]), destination: seed([...Array.from({ length: 50 }, (_, i) => ['paragraph', `Background ${i}`]), ['heading', 'Cells', { level: 1, id: 'stable-heading', 'data-toc-id': 'stable-heading' }], ['paragraph', 'Cell notes']]) });
    await page.route('**/mention-guide.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    const origin = `http://localhost:${server.httpServer.address().port}`;
    // Persist a saved view near the top before following a reference far below it.
    await page.goto(`${origin}/m2`);
    await page.locator('.tiptap').waitFor();
    await page.locator('.tiptap p').nth(2).hover(); await page.mouse.wheel(0, 200);
    await page.waitForTimeout(400);
    await page.getByRole('link', { name: 'Research', exact: true }).click();
    await page.waitForURL(`${origin}/m1`);
    const editor = page.locator('.tiptap[contenteditable=true]'); await editor.waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('@Cells');
    await page.getByRole('option', { name: 'Biology › Cells', exact: true }).click();
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).waitFor();
    await page.waitForTimeout(1600); await page.reload();
    await page.evaluate(async () => {
      const { saveModuleView } = await import('/src/lib/store.ts');
      saveModuleView('m2', { scrollTop: 0, anchor: 1, head: 1, focusedSection: null, foldedSections: [] });
    });
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).click(); await page.waitForURL(`${origin}/m2`);
    await page.waitForFunction(() => document.getSelection()?.anchorNode?.parentElement?.closest('h1') !== null);
    const heading = page.locator('.tiptap h1'); await heading.waitFor();
    // A later layout/backlink render must not restore the old top-of-note view.
    await page.waitForTimeout(300);
    const destinationTop = await heading.evaluate(el => el.getBoundingClientRect().top);
    await page.evaluate(async () => {
      const { queryClient } = await import('/src/lib/query-client.ts');
      await queryClient.invalidateQueries({ queryKey: ['mention-note', 'm1'] });
      const editor = document.querySelector('.tiptap');
      editor.style.height = `${editor.scrollHeight + 100}px`;
    });
    await page.waitForTimeout(300);
    assert.ok(Math.abs(await heading.evaluate(el => el.getBoundingClientRect().top) - destinationTop) < 2, 'reference destination moved after layout refresh');
    assert.ok(destinationTop >= 0 && destinationTop < 800, `destination outside viewport: ${destinationTop}`);
    const count = page.getByRole('button', { name: '1 incoming reference to Cells', exact: true });
    await heading.click(); await page.mouse.move(5, 5);
    await count.waitFor();
    await page.keyboard.press('Alt+F10');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-backlink-trigger'));
    assert.equal(await count.evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Focus on this section', exact: true }).evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-backlink-trigger'));
    assert.equal(await count.evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.classList.contains('tiptap'));
    assert.equal(await editor.evaluate(element => element === document.activeElement), true);
    for (const width of [360, 640, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await heading.hover();
      const row = await page.getByRole('toolbar', { name: 'Heading controls' }).evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: window.innerWidth, rowHeight: bounds.height, centers: [...element.children].map(child => { const r = child.getBoundingClientRect(); return r.top + r.height / 2; }) };
      });
      assert.ok(row.left >= 0 && row.right <= row.width, JSON.stringify(row));
      assert.ok(Math.max(...row.centers) - Math.min(...row.centers) < 1, JSON.stringify(row));
      assert.ok(row.rowHeight <= 28, JSON.stringify(row));
    }
    await heading.hover();
    await page.getByRole('button', { name: /^1 incoming reference/, exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Research', exact: true }).click(); await page.waitForURL(`${origin}/m1`);
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).click(); await page.waitForURL(`${origin}/m2`);
    await heading.click({ clickCount: 3 }); await page.keyboard.type('Living cells');
    assert.equal(await heading.innerText(), 'Living cells');
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: 'Actions for Biology', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Life science');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('link', { name: 'Research', exact: true }).click();
    await page.getByRole('button', { name: '@Life science › Living cells', exact: true }).waitFor();
    await page.reload(); await page.getByRole('button', { name: '@Life science › Living cells', exact: true }).waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' @Field');
    await page.getByRole('option', { name: 'Field guide.pdf', exact: true }).click();
    await page.getByRole('button', { name: '@Field guide.pdf', exact: true }).click();
    await page.waitForURL(`${origin}/files/pdf1`);
    await page.locator('.textLayer span').first().waitFor();
    await page.getByRole('button', { name: /^1 incoming reference/, exact: false }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Research', exact: true }).click();
    await page.waitForURL(`${origin}/m1`);
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' @Life');
    await page.getByRole('option', { name: 'Life science', exact: true }).click();
    await page.getByRole('button', { name: '@Life science', exact: true }).click();
    await page.waitForURL(`${origin}/m2`);
    await page.getByRole('button', { name: '1 incoming reference to Life science', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Research', exact: true }).click();
    await page.waitForURL(`${origin}/m1`);
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (process.env.PROOF_DIR) {
      await page.screenshot({ path: `${process.env.PROOF_DIR}/light.png` });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.screenshot({ path: `${process.env.PROOF_DIR}/dark.png` });
    }
  } finally { await browser?.close(); await server.close(); }
});

test('remote source changes refresh backlinks', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' }); let browser;
  const source = seed([['heading', 'Original source', { level: 1 }], ['mention', '', { target, mentionId: 'remote-link' }]]);
  const remote = new Y.Doc(); Y.applyUpdate(remote, Uint8Array.from(source));
  const vector = Y.encodeStateVector(remote);
  const text = remote.getXmlFragment('default').get(0).get(0);
  text.delete(0, text.length); text.insert(0, 'Renamed remotely');
  const bytes = [...Y.encodeStateAsUpdate(remote, vector)]; remote.destroy();
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage();
    await page.addInitScript(({ source, destination }) => {
      const contents = { m1: { state: source, updates: [], files: [] }, m2: { state: destination, updates: [], files: [] } };
      window.remoteContents = contents;
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith('plugin:')) return 1;
        if (command === 'modules') return [{ id: 'm1', name: 'Research' }, { id: 'm2', name: 'Biology' }];
        if (command === 'get_content') return structuredClone(contents[args.moduleId]);
        if (command === 'add_update') { const update = { id: Date.now(), bytes: args.bytes }; contents[args.moduleId].updates.push(update); return update; }
        return [];
      } } });
    }, { source, destination: seed([['heading', 'Cells', { level: 1, 'data-toc-id': 'stable-heading' }], ['paragraph', 'Cell notes']]) });
    await page.goto(`http://localhost:${server.httpServer.address().port}/m2`);
    await page.locator('.tiptap h1').hover();
    await page.getByRole('button', { name: '1 incoming reference to Cells', exact: true }).click();
    await page.getByRole('dialog').getByText('› Original source', { exact: true }).waitFor();
    await page.evaluate(async bytes => {
      const update = { id: 9000, bytes }; window.remoteContents.m1.updates.push(update);
      (await import('/src/lib/sync/apply-remote.ts')).onRemote({ updates: [{ moduleId: 'm1', update }], modulesChanged: false, deleted: [], reviewsChanged: false, filesChanged: false });
    }, bytes);
    await page.getByRole('dialog').getByText('› Renamed remotely', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('dialog').getByText('› Original source', { exact: true }).count(), 0);
  } finally { await browser?.close(); await server.close(); }
});
