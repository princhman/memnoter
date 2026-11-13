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
    }, { source: seed([['paragraph', 'See ']]), destination: seed([['heading', 'Cells', { level: 1, id: 'stable-heading', 'data-toc-id': 'stable-heading' }], ['paragraph', 'Cell notes']]) });
    await page.route('**/mention-guide.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes() }));
    const origin = `http://localhost:${server.httpServer.address().port}`;
    await page.goto(`${origin}/m1`);
    const editor = page.locator('.tiptap[contenteditable=true]'); await editor.waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('@Cells');
    await page.getByRole('option', { name: 'Biology › Cells', exact: true }).click();
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).waitFor();
    await page.waitForTimeout(1600); await page.reload();
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).click(); await page.waitForURL(`${origin}/m2`);
    await page.waitForFunction(() => document.getSelection()?.anchorNode?.parentElement?.closest('h1') !== null);
    const heading = page.locator('.tiptap h1'); await heading.waitFor(); await heading.hover();
    await page.getByRole('button', { name: 'Mentioned in 1', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Research', exact: true }).click(); await page.waitForURL(`${origin}/m1`);
    await page.getByRole('button', { name: '@Biology › Cells', exact: true }).click(); await page.waitForURL(`${origin}/m2`);
    await heading.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.type('Living cells');
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
    await page.getByRole('button', { name: 'Mentioned in 1', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Research', exact: true }).click();
    await page.waitForURL(`${origin}/m1`);
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' @Life');
    await page.getByRole('option', { name: 'Life science', exact: true }).click();
    await page.getByRole('button', { name: '@Life science', exact: true }).click();
    await page.waitForURL(`${origin}/m2`);
    await page.getByRole('button', { name: 'Mentioned in 1', exact: true }).click();
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
