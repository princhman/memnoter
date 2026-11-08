import { browserHarness } from "./support/browser.mjs";
import { execFileSync } from "node:child_process";
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createServer, webkit } = browserHarness(import.meta.url);

test('checked-in Swift bridge matches the web protocol', () => {
  execFileSync(process.execPath, [new URL('../../../scripts/generate-bridge-protocol.mjs', import.meta.url).pathname, '--check']);
});

test('WK host opens shared editors, publishes state and outline, and persists edits without desktop APIs', async t => {
  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const context = await browser.newContext({ reducedMotion: "reduce", hasTouch: true });
    const page = await context.newPage();
    if (process.env.SCROLL_TRACE) page.on('console', message => { if (message.text().startsWith('[scroll]')) console.log(message.text()); });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      window.__memnoterScrollDebug = true;
      window.messages = [];
      window.installTestBridge({ native: function(message) {
        window.messages.push(message);
        if (message.kind !== 'call') return;
        const { id, command, args } = message;
        let result;
        if (command === 'modules') result = [{ id: 'one' }, { id: 'two' }, { id: 'numbered', heading_numbering: window.numberingEnabled ?? true }];
        else if (command === 'get_content') result = { state: [], updates: [], files: [] };
        else if (command === 'add_update') result = { id: window.messages.length, bytes: args.bytes };
        else if (['sync_cards', 'card_schedules'].includes(command)) result = [];
        else if (command === 'resolve_card_image') result = 'files/keyboard-regression';
        else if (command === 'index_note') result = null;
        else throw Error(`Unexpected command: ${command}`);
        queueMicrotask(() => window.__memnoterBridge.resolve(id, result));
      } });
    });
    // Saved native preferences are untrusted across app upgrades. A bad caret
    // or missing heading must not turn a successful content read into failure.
    for (const saved of [
      { anchor: "invalid", head: 1, scrollTop: 0, focusedSection: null },
      { anchor: 1, head: 1, scrollTop: 0, focusedSection: 999999, foldedSections: ["deleted-heading"] },
    ]) {
      const recovery = await context.newPage();
      await recovery.addInitScript(saved => {
        window.__memnoterViewState = { viewByModule: { one: saved } };
      }, saved);
      await recovery.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
      await recovery.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
      await recovery.evaluate(() => window.memnoterEditor.open('one'));
      await recovery.locator('.tiptap[contenteditable=true]').click();
      await recovery.keyboard.type('Recovered editor');
      assert.ok((await recovery.locator('.tiptap').textContent()).includes('Recovered editor'));
      await recovery.evaluate(() => window.memnoterEditor.flush());
      const view = await recovery.evaluate(() => window.messages.filter(m => m.event === 'viewState').at(-1).payload.viewByModule.one);
      assert.equal(view.focusedSection, null);
      assert.deepEqual(view.foldedSections, []);
      await recovery.close();
    }
    await t.test('numbering in the note and native outline follows module preferences and the whole document', async () => {
      const numbered = await context.newPage();
      await numbered.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
      await numbered.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
      await numbered.evaluate(() => window.memnoterEditor.open('numbered'));
      await numbered.locator('.tiptap').click();
      for (const [level, title] of [[1, 'Parent'], [2, 'Nested'], [1, 'Second']]) {
        await numbered.evaluate(level => window.memnoterEditor.exec('heading', { level }), level);
        await numbered.keyboard.type(title);
        await numbered.keyboard.press('Enter');
      }
      const outline = () => numbered.evaluate(() => window.messages.filter(m => m.event === 'outline').at(-1).payload.headings);
      assert.deepEqual((await outline()).map(h => h.number), ['1', '1.1', '2']);
      assert.deepEqual(await numbered.locator('.heading-number').allTextContents(), ['1 ', '1.1 ', '2 ']);
      const second = (await outline())[2].id;
      await numbered.evaluate(id => window.memnoterEditor.exec('focusSection', { id }), second);
      assert.deepEqual((await outline()).map(h => h.number), ['2'], 'focus preserves the full-document chapter number');
      await numbered.evaluate(() => window.memnoterEditor.exec('showDocument'));
      const parent = (await outline())[0].id;
      await numbered.evaluate(id => window.memnoterEditor.exec('focusSection', { id }), parent);
      assert.deepEqual((await outline()).map(h => h.number), ['1', '1.1']);
      await numbered.evaluate(id => window.memnoterEditor.exec('foldCurrentSection'), parent);
      assert.equal((await outline()).at(-1).number, '1');
      await numbered.evaluate(() => window.memnoterEditor.exec('showDocument'));
      for (const enabled of [false, true]) {
        await numbered.evaluate(async enabled => {
          window.numberingEnabled = enabled;
          await window.memnoterEditor.refreshModules();
        }, enabled);
        await numbered.waitForFunction(enabled => !!document.querySelector('.heading-number') === enabled, enabled);
        assert.equal((await outline()).at(-1).number, enabled ? '2' : null);
      }
      await numbered.close();
    });
    await t.test('read-only Contents navigation works during an exclusive write while mutations stay blocked', async () => {
      const readOnly = await context.newPage();
      await readOnly.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
      await readOnly.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
      await readOnly.evaluate(() => window.memnoterEditor.open('one'));
      await readOnly.locator('.tiptap').click();
      await readOnly.evaluate(() => window.memnoterEditor.exec('heading', { level: 1 }));
      await readOnly.keyboard.type('Read-only heading');
      const headingText = await readOnly.locator('.tiptap h1').textContent();
      await readOnly.evaluate(async () => {
        const { exclusiveWrite } = await import('/src/lib/write-lifecycle.ts');
        window.write = exclusiveWrite(() => new Promise(resolve => { window.releaseWrite = resolve; }));
      });
      await readOnly.waitForFunction(() => !!window.releaseWrite);
      const result = await readOnly.evaluate(() => {
        const id = window.messages.filter(m => m.event === 'outline').at(-1).payload.headings[0].id;
        return {
          scroll: window.memnoterEditor.exec('scrollToHeading', { id }),
          focus: window.memnoterEditor.exec('focusSection', { id }),
          focused: window.messages.filter(m => m.event === 'state').at(-1).payload.focusedSectionId,
          show: window.memnoterEditor.exec('showDocument'),
          cleared: window.messages.filter(m => m.event === 'state').at(-1).payload.focusedSectionId,
          find: window.memnoterEditor.exec('find', { text: 'heading' }),
          mutate: window.memnoterEditor.exec('heading', { level: 2 }), id,
        };
      });
      await readOnly.evaluate(async () => { releaseWrite(); await window.write; });
      assert.equal(result.scroll, true);
      assert.equal(result.focus, true);
      assert.equal(result.focused, result.id);
      assert.equal(result.show, true);
      assert.equal(result.cleared, null);
      assert.equal(result.find, true);
      assert.equal(result.mutate, false);
      assert.equal(await readOnly.locator('.tiptap h1').textContent(), headingText);
      await readOnly.close();
    });
    // A native sync receipt must merge into the live Y.Doc while a draft is
    // still being edited, without replacing its DOM selection or local text.
    const synced = await context.newPage();
    await synced.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await synced.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
    await synced.evaluate(() => window.memnoterEditor.open('two'));
    await synced.locator('.tiptap').click();
    await synced.keyboard.type('Local draft');
    const selectionBefore = await synced.evaluate(() => window.getSelection().focusOffset);
    await synced.evaluate(async () => {
      const Y = await import('/node_modules/yjs/dist/yjs.mjs');
      const remote = new Y.Doc();
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Remote paragraph'); paragraph.insert(0, [text]);
      remote.getXmlFragment('default').insert(0, [paragraph]);
      window.memnoterEditor.applyRemote({ updates: [{ moduleId: 'two', update: { id: 100000, bytes: [...Y.encodeStateAsUpdate(remote)] } }], modulesChanged: false, deleted: [], reviewsChanged: false, filesChanged: false });
    });
    await synced.waitForFunction(() => document.querySelector('.tiptap').textContent.includes('Remote paragraph'));
    assert.ok((await synced.locator('.tiptap').textContent()).includes('Local draft'));
    assert.equal(await synced.evaluate(() => window.getSelection().focusOffset), selectionBefore);
    await synced.keyboard.type('!');
    assert.ok((await synced.locator('.tiptap').textContent()).includes('Local draft!'));
    await synced.evaluate(() => window.memnoterEditor.flush());
    await synced.close();
    await page.addInitScript(() => { window.__memnoterViewState = { skipCardsCreatedToday: true }; });
    await page.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await page.waitForFunction(() => window.messages.some(message => message.event === 'ready'));
    assert.deepEqual(await page.evaluate(async () => {
      const { appStore } = await import('/src/lib/store.ts');
      const initial = appStore.state.skipCardsCreatedToday;
      window.__memnoterBridge.emit('skip-cards-created-today', true);
      const enabled = appStore.state.skipCardsCreatedToday;
      window.__memnoterBridge.emit('skip-cards-created-today', false);
      return [initial, enabled, appStore.state.skipCardsCreatedToday];
    }), [false, true, false], 'only the native event controls the review preference');
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
    await page.keyboard.press('ArrowLeft');
    // Real WebKit layout: the last caret must clear native occlusion, and an
    // already visible caret must not move the reader on subsequent typing.
    await page.evaluate(() => {
      document.querySelector('.app-scroll-container').scrollTop = 0;
      window.memnoterEditor.setBottomInset(300);
    });
    await page.waitForFunction(() => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      range.collapse(false);
      const caret = range.getBoundingClientRect();
      const container = document.querySelector('.app-scroll-container');
      return caret.height > 0 && container.scrollTop > 0 && caret.bottom <= container.getBoundingClientRect().bottom - 324 + 1 && caret.top >= 0;
    });
    const visibleScroll = await page.locator('.app-scroll-container').evaluate(node => node.scrollTop);
    assert.ok(visibleScroll > 0);
    await page.keyboard.type('x');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(Math.abs(await page.locator('.app-scroll-container').evaluate(node => node.scrollTop) - visibleScroll) < 1);
    // Reuse this page/browser: Enter at the end of a long note must keep a
    // visible caret still, and reveal an occluded caret to the visible midpoint.
    const settleScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const caretGeometry = () => page.evaluate(() => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      range.collapse(false);
      const rect = range.getBoundingClientRect();
      const container = document.querySelector('.app-scroll-container');
      const top = container.getBoundingClientRect().top + container.clientTop + Number(container.dataset.topInset ?? 0);
      const bottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - Number(container.dataset.bottomInset ?? 0);
      return { scroll: container.scrollTop, caret: (rect.top + rect.bottom) / 2, midpoint: (top + bottom) / 2 };
    });
    await page.evaluate(() => window.memnoterEditor.setTopInset(60));
    await page.locator('.tiptap p').filter({ hasText: 'Tail ' }).evaluate(node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 4000);
      range.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await settleScroll();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tail Visible caret');
    await settleScroll();
    const beforeEnter = await caretGeometry();
    await page.keyboard.press('Enter');
    await settleScroll();
    const afterEnter = await caretGeometry();
    assert.ok(Math.abs(afterEnter.scroll - beforeEnter.scroll) < 1, JSON.stringify({ beforeEnter, afterEnter }));
    // Move the reader while leaving the selection in place, then type Enter.
    await page.evaluate(() => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      range.collapse(false);
      const container = document.querySelector('.app-scroll-container');
      const bottom = container.getBoundingClientRect().bottom - Number(container.dataset.bottomInset);
      container.scrollTop += range.getBoundingClientRect().bottom - bottom - 60;
    });
    await page.keyboard.press('Enter');
    await settleScroll();
    const revealed = await caretGeometry();
    assert.ok(Math.abs(revealed.caret - revealed.midpoint) < 20, JSON.stringify(revealed));
    await page.evaluate(() => window.memnoterEditor.setTopInset(0));
    await page.evaluate(() => window.memnoterEditor.setBottomInset(0));
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
        top: before - document.querySelector('.app-scroll-container').getBoundingClientRect().top,
        delta: heading.getBoundingClientRect().top - before };
    });
    assert.deepEqual(focus.firstVisible, ['First', 'First body']);
    assert.deepEqual(focus.visible, ['Child', 'Child body']);
    assert.equal(focus.caret, focus.id);
    assert.deepEqual(focus.path.map(c => [c.title, c.level]), [["Second", 1], ["Child", 2]]);
    assert.equal(focus.path.at(-1).id, focus.id);
    assert.equal(focus.cleared, null);
    assert.ok(Math.abs(focus.top) < 1, `Focused heading top: ${focus.top}`);
    assert.ok(Math.abs(focus.delta) < 1);
    // Empty headings have no TOC ID. They still belong in the native focus
    // path, whose IDs must decode as strings and be usable by focusSection.
    await page.locator('.tiptap h1').filter({ hasText: 'Second' }).evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      node.closest('.tiptap').focus();
    });
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.memnoterEditor.exec('heading', { level: 1 }));
    const emptyAncestor = await page.evaluate(() => {
      const headings = window.messages.filter(m => m.event === 'outline').at(-1).payload.headings;
      const child = headings.find(h => h.text === 'Child');
      window.memnoterEditor.exec('focusSection', { id: child.id });
      return window.messages.filter(m => m.event === 'state').at(-1).payload;
    });
    assert.ok(emptyAncestor.focusedSectionPath.every(c => typeof c.id === 'string'));
    await page.locator('.tiptap p').filter({ hasText: 'Child body' }).click();
    const currentFocus = await page.evaluate(() => {
      window.memnoterEditor.exec('showDocument');
      const before = window.messages.filter(m => m.event === 'state').length;
      const result = window.memnoterEditor.exec('focusCurrentSection');
      const states = window.messages.filter(m => m.event === 'state');
      return { result, emitted: states.length > before, state: states.at(-1).payload,
        top: document.querySelector('.section-focus-start').getBoundingClientRect().top - document.querySelector('.app-scroll-container').getBoundingClientRect().top };
    });
    assert.ok(Math.abs(currentFocus.top) < 1, `Current section top: ${currentFocus.top}`);
    assert.equal(currentFocus.result, true);
    assert.equal(currentFocus.emitted, true);
    assert.equal(currentFocus.state.focusedSectionId, emptyAncestor.focusedSectionId);
    assert.equal(currentFocus.state.focusedSectionPath.at(-1).title, 'Child');
    assert.ok(currentFocus.state.focusedSectionPath.every(c => typeof c.id === 'string'));
    // Flush immediately after a selection change: the view debounce must not
    // lose the caret when native suspends JS or switches notes.
    const persisted = await page.evaluate(async () => {
      window.memnoterEditor.exec('focusSection', { id: window.messages.filter(m => m.event === 'outline').at(-1).payload.headings.find(h => h.text === 'Child').id });
      await window.memnoterEditor.flush();
      return window.messages.filter(m => m.event === 'viewState').at(-1)?.payload;
    });
    assert.equal(Object.hasOwn(persisted, "skipCardsCreatedToday"), false);
    assert.ok(persisted?.viewByModule.one.focusedSection > 0);
    assert.ok(persisted.viewByModule.one.anchor > 0);
    // Native restores focus from preferences before opening content. Old saved
    // scroll offsets must not defeat heading alignment or the caret reveal.
    const updates = await page.evaluate(() => window.messages.filter(m => m.kind === 'call' && m.command === 'add_update' && m.args.moduleId === 'one').map((m, i) => ({ id: i + 1, bytes: m.args.bytes })));
    const restored = await context.newPage();
    await restored.addInitScript(({ persisted, updates }) => {
      window.__memnoterViewState = persisted;
      persisted.viewByModule.one.scrollTop = 500;
      delete persisted.viewByModule.one.scrollAnchor;
      const original = window.webkit.messageHandlers.memnoter.postMessage;
      window.webkit.messageHandlers.memnoter.postMessage = message => {
        if (message.kind === 'call' && message.command === 'get_content') {
          window.messages.push(message);
          queueMicrotask(() => window.__memnoterBridge.resolve(message.id, { state: [], updates, files: [] }));
        } else original(message);
      };
    }, { persisted, updates });
    await restored.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
    await restored.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
    await restored.evaluate(() => window.memnoterEditor.open('one'));
    await restored.waitForFunction(() => {
      const heading = document.querySelector('.section-focus-start');
      const container = document.querySelector('.app-scroll-container');
      return heading && Math.abs(heading.getBoundingClientRect().top - container.getBoundingClientRect().top) < 1;
    });
    await restored.close();
    await page.bringToFront();
    const exec = (command, args) => page.evaluate(([command, args]) => window.memnoterEditor.exec(command, args), [command, args]);
    await t.test('card info taps preserve focus and selection and consume dismissal', async () => {
      const menu = await context.newPage();
      await menu.setViewportSize({ width: 820, height: 1180 });
      await menu.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
      await menu.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
      await menu.evaluate(() => window.memnoterEditor.open('card-menu'));
      await menu.locator('.tiptap').click();
      await menu.keyboard.type('{{first}} {{second}}');
      await menu.evaluate(() => { window.memnoterEditor.setTopInset(88); window.memnoterEditor.setBottomInset(350); });
      const dot = menu.getByRole('group', { name: 'Card details', exact: true }).first();
      const popup = dot.getByRole('dialog', { name: 'Card details', exact: true });
      const snapshot = () => menu.evaluate(() => {
        const selection = window.getSelection();
        return { focused: document.activeElement === document.querySelector('.tiptap'),
          anchor: selection.anchorOffset, head: selection.focusOffset,
          text: selection.anchorNode?.textContent, scroll: document.querySelector('.app-scroll-container').scrollTop };
      });
      const tapDot = () => dot.tap();
      for (const focused of [true, false]) {
        if (!focused) {
          await menu.evaluate(() => { document.activeElement?.blur(); window.getSelection()?.removeAllRanges(); });
          // Allow WebKit to release focus before exercising the native action.
          await menu.waitForFunction(() => document.activeElement !== document.querySelector('.tiptap') && window.getSelection().rangeCount === 0);
        }
        const before = await snapshot();
        await tapDot();
        assert.deepEqual(await snapshot(), before);
        assert.equal(await popup.isVisible(), true);
        const bounds = await popup.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 820);
        assert.ok(bounds.y >= 88 && bounds.y + bounds.height <= 830);
        await menu.touchscreen.tap(400, 500);
        assert.equal(await popup.isVisible(), false);
        assert.deepEqual(await snapshot(), before, 'dismissal must consume the editing tap');
        await tapDot();
        await tapDot();
        assert.equal(await popup.isVisible(), false);
        assert.deepEqual(await snapshot(), before, 'dot toggling must preserve the responder');
      }
      await menu.touchscreen.tap(400, 500);
      assert.equal((await snapshot()).focused, true, 'the next outside tap edits normally');
      await tapDot();
      await menu.getByRole('button', { name: 'Join into one card' }).tap();
      await menu.waitForFunction(() => !document.querySelector('.card-info-join'));
      assert.ok((await menu.locator('.tiptap').textContent()).includes('{{first}} {{second}}'));
      await menu.close();
    });
    await t.test('iPad typing and section navigation retain the reader position', async () => {
      // A short final section still needs to reach the visible top. Keep its
      // screen position through delayed content reflow, with and without
      // native keyboard occlusion. Exercise the public WK protocol and layout.
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.evaluate(() => window.memnoterEditor.open('scroll-regression'));
      await page.locator('.tiptap').click();
      await page.keyboard.insertText(('Content above the last section. '.repeat(15) + '\n').repeat(30));
      await exec('heading', { level: 1 });
      await page.keyboard.type('Final section');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Short final body');
      // Twenty real keystrokes in the middle of a long note must not move a
      // visible caret. This catches competing reveal/animation writers.
      await page.locator('.tiptap p').filter({ hasText: 'Content above the last section.' }).first().evaluate(node => {
        const text = node.firstChild;
        const range = document.createRange();
        range.setStart(text, Math.floor(text.textContent.length / 2));
        range.collapse(true);
        node.closest('.tiptap').focus({ preventScroll: true });
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(350);
      const middleScroll = await page.locator('.app-scroll-container').evaluate(node => node.scrollTop);
      for (const character of 'abcdefghijklmnopqrst') {
        await page.keyboard.type(character);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.ok(Math.abs(await page.locator('.app-scroll-container').evaluate(node => node.scrollTop) - middleScroll) < 1, 'Visible typing moved the note');
      }
      const finalId = await page.evaluate(() => window.messages.filter(m => m.event === 'outline').at(-1).payload.headings.find(h => h.text === 'Final section').id);
      for (const keyboard of [0, 300]) {
        await page.evaluate(keyboard => {
          window.memnoterEditor.setTopInset(88);
          window.memnoterEditor.setBottomInset(keyboard);
        }, keyboard);
        await exec('focusSection', { id: finalId });
        await page.waitForFunction(() => {
          const heading = document.querySelector('.section-focus-start').getBoundingClientRect();
          return heading.top >= 88 && heading.top <= 92 && heading.bottom < 1180 - 300;
        });
        const delta = await page.evaluate(async () => {
          const heading = document.querySelector('.section-focus-start');
          const before = heading.getBoundingClientRect().top;
          window.memnoterEditor.exec('showDocument');
          // Reflow during the bounded settle must preserve the heading.
          // Change actual NodeView geometry through the public WK boundary.
          window.memnoterEditor.setBottomInset(Number(document.querySelector('.app-scroll-container').dataset.bottomInset));
          await new Promise(resolve => requestAnimationFrame(resolve));
          const paragraph = document.querySelector('.tiptap p');
          paragraph.style.paddingBottom = `${parseFloat(getComputedStyle(paragraph).paddingBottom) + 240}px`;
          await new Promise(resolve => setTimeout(resolve, 350));
          return heading.getBoundingClientRect().top - before;
        });
        assert.ok(Math.abs(delta) <= 4, `Unfocus moved final heading by ${delta} with keyboard inset ${keyboard}`);
      }
      // A finished navigation must release its anchor even without new input.
      // Later content layout belongs to the reader, not the old command.
      await page.waitForTimeout(350);
      const releasedScroll = await page.locator('.app-scroll-container').evaluate(node => node.scrollTop);
      await page.locator('.tiptap').evaluate(node => { node.style.fontSize = '24px'; });
      await page.waitForTimeout(350);
      assert.ok(Math.abs(await page.locator('.app-scroll-container').evaluate(node => node.scrollTop) - releasedScroll) < 1, 'Expired section anchor moved the reader');
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => { window.memnoterEditor.setTopInset(0); window.memnoterEditor.setBottomInset(0); });
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
    await page.waitForFunction(() => window.messages.filter(m => m.event === 'state').at(-1).payload.canMakeCard);
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
    assert.equal(await page.locator('.toc').count(), 0, 'native host has no hover rail');
    const focusedBeforeContents = (await state()).focusedSectionId;
    const headings = await page.evaluate(() => window.messages.filter(m => m.event === 'outline').at(-1).payload.headings);
    assert.ok(headings.length > 0);
    await exec('scrollToHeading', { id: headings.find(h => h.level === 2).id });
    assert.equal((await state()).focusedSectionId, focusedBeforeContents);
    await exec('insertSection', { kind: 'sibling' });
    await page.keyboard.type('Sibling section');
    assert.equal((await state()).headingLevel, 2);
    assert.equal(await page.locator('.tiptap').evaluate(node => node === document.activeElement), true);
    // Image selection is an editing action, but must not request text input.
    // Use the public host command and NodeView click, then return to a caret.
    await exec('showDocument');
    assert.equal(await exec('insertImage', { fileId: 'keyboard-regression' }), true);
    await page.locator('.note-image-host').dispatchEvent('click');
    assert.equal(await page.locator('.tiptap').getAttribute('inputmode'), 'none');
    assert.equal((await state()).suppressKeyboard, true);
    await page.getByRole('button', { name: 'Alt text and title', exact: true }).click();
    await page.getByPlaceholder('Describe the image').click();
    assert.equal(await page.getByPlaceholder('Describe the image').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByPlaceholder('Describe the image').getAttribute('inputmode'), null);
    await page.locator('.tiptap h2').filter({ hasText: 'Sibling section' }).click();
    await page.waitForFunction(() => document.querySelector('.tiptap').getAttribute('inputmode') === null);
    assert.equal(await page.locator('.tiptap').getAttribute('inputmode'), null);
    assert.equal((await state()).suppressKeyboard, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await server.close();
  }
});
