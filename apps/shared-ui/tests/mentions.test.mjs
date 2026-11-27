import { textPdfBytes } from "./browser/pdf-text-selection-pdf.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { extractMentions, backlinks, mentionLabel } from '../src/lib/mention-index.ts';
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
test('a nested section reference is labelled with its full path', () => {
  const notes = [{ id: 'm1', name: 'Logic', note: { headings: [{ id: 'h1', title: 'Hello', path: [] }, { id: 'h2', title: 'Hello 2', path: ['Hello'] }], mentions: [] } }];
  const heading = id => ({ kind: 'heading', id: 'm1', nodeId: id, locator: null });
  assert.equal(mentionLabel(notes, [], heading('h2')), 'Logic › Hello / Hello 2');
  assert.equal(mentionLabel(notes, [], heading('h1')), 'Logic › Hello');
  assert.equal(mentionLabel(notes, [], { kind: 'module', id: 'm1', nodeId: null, locator: null }), 'Logic');
});
test('image labels use captions or section numbering, and deleted targets lose their labels', () => {
  const note = extractMentions({ type: 'doc', content: [
    { type: 'image', attrs: { imageId: 'cover' } },
    { type: 'heading', content: [{ type: 'text', text: 'Cells' }] },
    { type: 'image', attrs: { imageId: 'captioned', title: 'Cell diagram' } },
    { type: 'paragraph', content: [{ type: 'inlineImage', attrs: { imageId: 'inline', alt: 'uploaded.png' } }] },
  ] });
  const notes = [{ id: 'm1', name: 'Biology', note }];
  const image = id => ({ kind: 'image', id: 'm1', nodeId: id, locator: null });
  assert.equal(mentionLabel(notes, [], image('cover')), 'Biology › Image 1');
  assert.equal(mentionLabel(notes, [], image('captioned')), 'Biology › Cell diagram');
  assert.equal(mentionLabel(notes, [], image('inline')), 'Biology › Cells / Image 2');
  assert.equal(mentionLabel(notes, [], image('deleted')), undefined);
  assert.equal(mentionLabel(notes, [], { kind: 'pdf-page', id: 'deleted', nodeId: null, locator: '12' }), undefined);
  for (const kind of ['question', 'worksheet']) {
    assert.equal(mentionLabel(notes, [], { kind, id: 'm1', nodeId: 'deleted', locator: null }), undefined);
  }
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
    }, { source: seed([['paragraph', 'See ']]), destination: seed([...Array.from({ length: 50 }, (_, i) => ['paragraph', `Background ${i}`]), ['heading', 'Cells', { level: 1, id: 'stable-heading', 'data-toc-id': 'stable-heading' }], ['heading', 'Organelles', { level: 2, 'data-toc-id': 'child-heading' }], ['paragraph', 'Cell notes']]) });
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
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('@');
    // Browsing lists modules (the edited one first) and files; sections wait behind Tab.
    const names = async () => page.getByRole('option').evaluateAll(options => options.map(option => [...option.childNodes].filter(node => node.nodeName !== 'KBD').map(node => node.textContent).join('')));
    const header = page.locator('[data-menu-header]');
    const paragraph = page.locator('.tiptap p').last();
    await page.getByRole('option', { name: 'Biology', exact: true }).waitFor();
    assert.deepEqual(await names(), ['Research', 'Biology', 'Field guide.pdf', 'Field guide.pdf pages']);
    assert.equal(await header.count(), 0);
    await page.keyboard.press('Tab');
    assert.deepEqual(await names(), ['Research', 'Biology', 'Field guide.pdf', 'Field guide.pdf pages'], 'Tab on a module without sections does nothing');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await page.getByRole('option', { name: 'Cells', exact: true }).waitFor();
    assert.deepEqual(await names(), ['Cells']);
    assert.equal(await header.innerText(), 'Biology');
    await page.keyboard.press('Tab');
    await page.getByRole('option', { name: 'Organelles', exact: true }).waitFor();
    assert.deepEqual(await names(), ['Organelles']);
    assert.equal(await header.innerText(), 'Biology / Cells');
    await page.keyboard.press('Tab');
    assert.deepEqual(await names(), ['Organelles']);
    await page.keyboard.press('Shift+Tab');
    await page.getByRole('option', { name: 'Cells', exact: true }).waitFor();
    assert.equal(await header.innerText(), 'Biology');
    // Digging never edits the note, and Backspace on an empty query climbs out instead of deleting "@".
    assert.equal(await paragraph.innerText(), 'See @');
    await page.keyboard.press('Backspace');
    await page.getByRole('option', { name: 'Biology', exact: true }).waitFor();
    assert.deepEqual(await names(), ['Research', 'Biology', 'Field guide.pdf', 'Field guide.pdf pages']);
    assert.equal(await paragraph.innerText(), 'See @');
    // Enter must work as soon as the next level appears, as well as after a normal key press.
    for (const immediate of [true, false]) {
      if (immediate) {
        await page.evaluate(() => {
          window.mentionHandoff = null;
          const observer = new MutationObserver(() => {
            const options = [...document.querySelectorAll('[role="option"]')];
            if (document.querySelector('[data-menu-header]')?.textContent !== 'Biology' || options[0]?.textContent?.replace(/Tab$/, '') !== 'Cells') return;
            observer.disconnect();
            const focused = document.activeElement;
            window.mentionHandoff = {
              options: options.map(option => ({ text: option.textContent?.replace(/Tab$/, ''), selected: option.getAttribute('aria-selected') })),
              editorFocused: focused?.matches('.tiptap[contenteditable=true]'),
              activeDescendantSelected: focused?.getAttribute('aria-activedescendant') === options[0].id,
            };
            focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        });
      }
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Tab');
      if (immediate) {
        await page.waitForFunction(() => window.mentionHandoff !== null);
        assert.deepEqual(await page.evaluate(() => window.mentionHandoff), {
          options: [{ text: 'Cells', selected: 'true' }], editorFocused: true, activeDescendantSelected: true,
        }, 'the first nested option must be selected when it appears');
      } else {
        await page.getByRole('option', { name: 'Cells', exact: true }).waitFor();
        await page.keyboard.press('Enter');
      }
      await page.getByRole('button', { name: '@Biology › Cells', exact: true }).waitFor();
      await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
      await page.waitForFunction(() => !document.querySelector('.mention-chip'));
      await page.keyboard.type('@');
      await page.getByRole('option', { name: 'Biology', exact: true }).waitFor();
    }
    // Searching matches the full path and shows where each section lives.
    await page.keyboard.type('biology organelles');
    await page.getByRole('option', { name: 'Organelles Biology / Cells', exact: true }).waitFor();
    assert.deepEqual(await names(), ['OrganellesBiology / Cells']);
    await page.keyboard.press('Escape');
    for (let i = 0; i < '@biology organelles'.length; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('@Cells');
    await page.getByRole('option', { name: 'Cells Biology', exact: true }).click();
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


test('insert and follow image, PDF page, question and worksheet mentions', async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  const proof = process.env.PROOF_DIR;
  const pause = page => proof ? page.waitForTimeout(1000) : Promise.resolve();
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180" viewBox="0 0 420 180"><rect width="420" height="180" fill="#e9e4ff"/><ellipse cx="210" cy="90" rx="145" ry="63" fill="#baacec"/><ellipse cx="215" cy="90" rx="47" ry="35" fill="#6954a6"/><ellipse cx="124" cy="85" rx="18" ry="8" fill="#fff"/><ellipse cx="299" cy="110" rx="22" ry="9" fill="#fff"/></svg>');
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 780 } });
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => console.error('PAGE:', error.message));
    await page.addInitScript(({ source, destination }) => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      const modules = [{ id: 'm1', name: 'Research' }, { id: 'm2', name: 'Biology' }];
      const contents = { m1: { state: source, updates: [], files: [] }, m2: { state: destination, updates: [], files: [] } };
      const bank = { schemaVersion: 1, questions: {}, revisions: {}, attempts: {}, answers: {} };
      for (let index = 0; index < 24; index++) {
        const questionId = `q${index}`, revisionId = `r${index}`, rootPartId = `p${index}`;
        bank.questions[questionId] = { title: index === 23 ? 'Study cell structure' : `Review question ${index + 1}`, order: index, revisionId, deleted: false };
        bank.revisions[revisionId] = { questionId, rootPartId, parts: { [rootPartId]: { parentId: null, order: 0, label: '', cropIds: [] } }, crops: {} };
      }
      bank.attempts.a1 = { title: 'Study practice worksheet', questions: [{ questionId: 'q23', revisionId: 'r23' }], deleted: false };
      let pageCount = null;
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith('plugin:')) return 1;
        if (command === 'modules') return modules;
        if (command === 'get_content') return structuredClone(contents[args.moduleId]);
        if (command === 'add_update') {
          const update = { id: Date.now(), bytes: args.bytes };
          contents[args.moduleId].updates.push(update);
          return update;
        }
        if (command === 'document_path') return '/study-guide.pdf';
        if (command === 'list_documents') return [{ id: 'pdf1', moduleId: 'm2', moduleName: 'Biology', name: 'Study guide.pdf', size: 1, pageCount, available: true }];
        if (command === 'set_document_page_count') { pageCount = args.pageCount; return; }
        if (command === 'question_bank_enabled') return true;
        if (command === 'question_bank_get') return args.moduleId === 'm2' ? bank : null;
        if (command === 'worksheet_answer_document_load') return { document: [0, 0], expected: 'empty', plainText: null };
        return [];
      } } });
    }, {
      source: seed([['heading', 'Reading notes'], ['paragraph', 'See ']]),
      destination: seed([...Array.from({ length: 42 }, (_, i) => ['paragraph', `Background note ${i + 1}`]), ['heading', 'Cell diagrams', { level: 1 }], ['image', '', { imageId: 'cell', title: 'Study cell diagram', src: image, width: 420, height: 180 }]]),
    });
    await page.route('**/study-guide.pdf', route => route.fulfill({ contentType: 'application/pdf', body: textPdfBytes(12) }));
    const origin = `http://localhost:${server.httpServer.address().port}`;
    await page.goto(`${origin}/m1`);
    const editor = page.locator('.tiptap[contenteditable=true]');
    const type = value => page.keyboard.type(value, { delay: proof ? 80 : 0 });
    const insertQuery = async value => {
      await editor.getByRole('heading', { name: 'Reading notes' }).waitFor();
      await editor.evaluate(element => element.editor.commands.focus('end'));
      await page.waitForFunction(() => {
        const editor = document.querySelector('.tiptap[contenteditable=true]')?.editor;
        if (!editor?.view.hasFocus()) return false;
        const selection = editor.view.dom.ownerDocument.getSelection();
        const head = editor.state.doc.content.size - 1;
        return editor.state.selection.empty && editor.state.selection.head === head &&
          selection?.isCollapsed && editor.view.dom.contains(selection.anchorNode) &&
          editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) === head;
      });
      await type(value);
    };
    const option = name => page.getByRole('option', { name, exact: true });
    const chip = name => page.getByRole('button', { name, exact: true });
    await insertQuery('@Study');
    await option('Study cell diagram Biology').waitFor();
    await option('Study guide.pdf pages').waitFor();
    await option('Study cell structure Biology').waitFor();
    await option('Study practice worksheet Biology').waitFor();
    await pause(page);
    if (proof) {
      await page.screenshot({ path: `${proof}/mentions-light.png` });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      await page.screenshot({ path: `${proof}/mentions-dark.png`, animations: 'disabled' });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    }
    await option('Study cell diagram Biology').click();
    await chip('@Biology › Study cell diagram').waitFor();
    await pause(page);
    await chip('@Biology › Study cell diagram').click();
    await page.waitForURL(`${origin}/m2`);
    const targetImage = page.locator('.note-image-block[data-selected] img').first();
    await targetImage.waitFor();
    assert.ok(await targetImage.evaluate(image => {
      const viewport = image.closest('.app-scroll-container').getBoundingClientRect();
      const box = image.getBoundingClientRect();
      return image.complete && box.top >= viewport.top && box.bottom <= viewport.bottom;
    }), 'the exact image is selected and visible');
    await pause(page);
    const backToNote = async () => {
      await page.getByRole('link', { name: 'Research', exact: true }).click();
      await page.waitForURL(`${origin}/m1`);
    };
    await backToNote();
    await insertQuery('@Study guide');
    await option('Study guide.pdf pages').click();
    await option('Page 12').waitFor();
    await type(' 12');
    await option('Page 12').waitFor();
    await pause(page);
    await option('Page 12').click();
    await chip('@Study guide.pdf p.12').waitFor();
    await pause(page);
    await chip('@Study guide.pdf p.12').click();
    await page.waitForURL(`${origin}/files/pdf1?page=12`);
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.pdf-viewport')?.getBoundingClientRect();
      const line = [...document.querySelectorAll('[data-pdf-page="12"] .textLayer span')].find(span => span.textContent === 'Page 12 first line');
      const box = line?.getBoundingClientRect();
      return document.querySelector('input[aria-label="Page number"]')?.value === '12' &&
        box && viewport && box.top >= viewport.top && box.bottom <= viewport.bottom;
    });
    await pause(page);
    await backToNote();
    await insertQuery('@Study cell structure');
    await option('Study cell structure Biology').waitFor();
    await pause(page);
    await option('Study cell structure Biology').click();
    await chip('@Study cell structure').waitFor();
    await pause(page);
    await chip('@Study cell structure').click();
    await page.waitForURL(url => url.pathname === '/questions' && url.searchParams.get('question') === 'q23');
    const question = page.getByRole('button', { name: 'Add next crops to Study cell structure' });
    await question.waitFor();
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-question-id="q23"]');
      const viewport = row?.closest('.app-scroll-container')?.getBoundingClientRect();
      const box = row?.getBoundingClientRect();
      return box && viewport && box.top >= viewport.top && box.bottom <= viewport.bottom;
    });
    await pause(page);
    await backToNote();
    await insertQuery('@Study practice');
    await option('Study practice worksheet Biology').waitFor();
    await pause(page);
    await option('Study practice worksheet Biology').click();
    await chip('@Study practice worksheet').waitFor();
    await pause(page);
    await chip('@Study practice worksheet').click();
    await page.waitForURL(url => url.pathname === '/questions' && url.searchParams.get('worksheet') === 'a1');
    const header = page.locator('header');
    await header.getByText('Study practice worksheet', { exact: true }).waitFor();
    await header.getByRole('button', { name: 'Question 1: Study cell structure', exact: true }).waitFor();
    await pause(page);
    await page.close();
  } finally { await server.close(); }
});
