import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';

test('WK host opens shared editors, publishes state and outline, and persists edits without desktop APIs', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const cacheDir = await mkdtemp(`${root}node_modules/.memnoter-host-`);
  const server = await createServer({ root, cacheDir, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.messages = [];
      window.webkit = { messageHandlers: { memnoter: { postMessage(message) {
        window.messages.push(message);
        if (message.kind !== 'call') return;
        const { id, command, args } = message;
        let result;
        if (command === 'modules') result = [{ id: 'one' }, { id: 'two' }];
        else if (command === 'get_content') result = { state: [], updates: [], files: [] };
        else if (command === 'add_update') result = { id: window.messages.length, bytes: args.bytes };
        else if (['sync_cards', 'card_schedules'].includes(command)) result = [];
        else if (command === 'index_note') result = null;
        else throw Error(`Unexpected command: ${command}`);
        queueMicrotask(() => window.__memnoterBridge.resolve(id, result));
      } } } };
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await page.waitForFunction(() => window.messages.some(message => message.event === 'ready'));
    await page.evaluate(() => window.memnoterEditor.open('one'));
    await page.locator('.tiptap[contenteditable=true]').waitFor();
    assert.equal(await page.locator('header, aside, nav').count(), 0);
    await page.evaluate(() => {
      window.memnoterEditor.focus();
      window.memnoterEditor.exec('heading', { level: 2 });
    });
    await page.waitForFunction(() => window.messages.some(message => message.event === 'outline' && message.payload.headings.some(heading => heading.level === 1)));
    // The exec boundary must reveal only the requested section, move a stale
    // caret into it, and preserve its screen position when restoring the note.
    await page.locator('.tiptap').click();
    await page.keyboard.press('Meta+a');
    await page.evaluate(() => window.memnoterEditor.exec('heading', { level: 1 }));
    await page.keyboard.type('First');
    await page.evaluate(() => window.memnoterEditor.exec('heading', { level: 1 }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('First body');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.memnoterEditor.exec('heading', { level: 1 }));
    await page.keyboard.type('Second');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.memnoterEditor.exec('heading', { level: 2 }));
    await page.keyboard.type('Child');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Child body');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Tail '.repeat(2000));
    const focus = await page.evaluate(() => {
      const outline = window.messages.filter(m => m.event === 'outline').at(-1).payload.headings;
      const first = outline.find(h => h.text === 'First');
      const child = outline.find(h => h.text === 'Child');
      window.memnoterEditor.exec('focusSection', { id: first.id });
      const firstVisible = [...document.querySelectorAll('.tiptap > *')].filter(n => n.getBoundingClientRect().height).map(n => n.textContent).filter(t => t && !t.startsWith('Tail '));
      window.memnoterEditor.exec('focusSection', { id: child.id });
      const state = window.messages.filter(m => m.event === 'state').at(-1).payload;
      const visible = [...document.querySelectorAll('.tiptap > *')].filter(n => n.getBoundingClientRect().height).map(n => n.textContent).filter(t => t && !t.startsWith('Tail '));
      const heading = document.querySelector(`[data-toc-id="${child.id}"]`);
      const before = heading.getBoundingClientRect().top;
      window.memnoterEditor.exec('showDocument');
      return { firstVisible, visible, caret: state.headingId, id: child.id, path: state.focusedSectionPath,
        cleared: window.messages.filter(m => m.event === 'state').at(-1).payload.focusedSectionId,
        delta: heading.getBoundingClientRect().top - before };
    });
    assert.deepEqual(focus.firstVisible, ['First', 'First body']);
    assert.deepEqual(focus.visible, ['Child', 'Child body']);
    assert.equal(focus.caret, focus.id);
    assert.deepEqual(focus.path.map(c => [c.title, c.level]), [["Second", 1], ["Child", 2]]);
    assert.equal(focus.path.at(-1).id, focus.id);
    assert.equal(focus.cleared, null);
    assert.ok(Math.abs(focus.delta) < 1);
    // Flush immediately after a selection change: the view debounce must not
    // lose the caret when native suspends JS or switches notes.
    const persisted = await page.evaluate(async () => {
      window.memnoterEditor.exec('focusSection', { id: window.messages.filter(m => m.event === 'outline').at(-1).payload.headings.find(h => h.text === 'Child').id });
      await window.memnoterEditor.flush();
      return window.messages.filter(m => m.event === 'viewState').at(-1)?.payload;
    });
    assert.ok(persisted?.viewByModule.one.focusedSection > 0);
    assert.ok(persisted.viewByModule.one.anchor > 0);
    const result = await page.evaluate(async () => {
      await window.memnoterEditor.open('two');
      return {
        state: window.messages.filter(message => message.event === 'state').at(-1).payload,
        calls: window.messages.filter(message => message.kind === 'call').map(message => message.command),
        unknown: window.memnoterEditor.exec('unknown'),
      };
    });
    assert.equal(result.state.moduleId, 'two');
    assert.ok(result.calls.includes('add_update'));
    assert.equal(result.calls.some(command => command.startsWith('plugin:') || command === 'set_editor_history'), false);
    assert.equal(result.unknown, false);
    // Exercise the public WK bridge against the real shared schema/commands.
    const exec = (command, args) => page.evaluate(([command, args]) => window.memnoterEditor.exec(command, args), [command, args]);
    const state = () => page.evaluate(() => window.messages.filter(m => m.event === 'state').at(-1).payload);
    await page.evaluate(() => window.memnoterEditor.focus());
    for (let level = 1; level <= 6; level++) {
      assert.equal(await exec('heading', { level }), true);
      await page.keyboard.type(`Level ${level}`);
      assert.equal((await state()).headingLevel, level);
      await page.keyboard.press('Enter');
    }
    await exec('paragraph');
    assert.equal(await exec('codeBlock'), true);
    await page.keyboard.type('const answer = 42;');
    assert.equal(await page.locator('.tiptap pre').textContent(), 'const answer = 42;');
    assert.equal((await state()).canIndent, false);
    await exec('codeBlock');
    await page.keyboard.press('Enter');
    await exec('bulletList');
    await page.keyboard.type('Parent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Child');
    assert.equal((await state()).canIndent, true);
    assert.equal(await exec('indent'), true);
    assert.equal(await page.locator('.tiptap li li').textContent(), 'Child');
    assert.equal((await state()).canOutdent, true);
    assert.equal(await exec('outdent'), true);
    assert.equal(await page.locator('.tiptap li li').count(), 0);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await exec('heading', { level: 1 });
    await page.keyboard.type('Cards');
    await page.keyboard.press('Enter');
    await exec('insertSection', { kind: 'subsection' });
    await page.keyboard.type('Child section');
    assert.equal((await state()).headingLevel, 2);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Answer');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft');
    assert.equal((await state()).canMakeCard, true);
    assert.equal(await exec('makeCard'), true);
    assert.equal((await state()).inCloze, true);
    assert.ok((await page.locator('.tiptap').textContent()).includes('{{Answer}}'));
    assert.equal(await exec('removeCard'), true);
    assert.equal((await state()).inCloze, false);
    await page.keyboard.type('{{one}} {{two}}');
    await page.locator('.tiptap p[data-card-kind="cloze"]').evaluate(node => {
      const answers = node.querySelectorAll('.cloze-text');
      const range = document.createRange();
      range.setStart(answers[0].firstChild, 0);
      range.setEnd(answers[1].firstChild, answers[1].textContent.length);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await page.waitForFunction(() => window.messages.filter(m => m.event === 'state').at(-1).payload.canJoinClozes);
    assert.equal((await state()).canJoinClozes, true);
    assert.equal(await exec('joinClozes'), true);
    assert.equal((await state()).canJoinClozes, false);
    assert.equal(await exec('foldCurrentSection'), true);
    assert.equal((await state()).folded, true);
    assert.equal(await exec('unfoldCurrentSection'), true);
    assert.equal((await state()).folded, false);
    await exec('insertSection', { kind: 'sibling' });
    await page.keyboard.type('Sibling section');
    assert.equal((await state()).headingLevel, 2);
    assert.equal(await page.locator('.tiptap').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true });
  }
});
