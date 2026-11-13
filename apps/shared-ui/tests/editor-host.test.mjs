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
    await t.test('unfolding a block on iPad preserves the reader scroll and does not focus an old caret', async () => {
      const reader = await context.newPage();
      try {
        await reader.setViewportSize({ width: 1024, height: 768 });
        await reader.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await reader.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        await reader.evaluate(() => window.memnoterEditor.open('fold-scroll'));
        await reader.locator('.tiptap').click();
        await reader.locator('.tiptap').evaluate(element => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/html', '<p>Old caret</p>' + '<p>Reading above the example</p>'.repeat(45)
            + '<details><summary>Worked example</summary><div data-type="detailsContent"><p>Hidden solution</p></div></details>'
            + '<p>Reading below the example</p>'.repeat(25));
          element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
        });
        await reader.locator('.tiptap p').first().click();
        await reader.locator('.tiptap').evaluate(element => element.blur());
        const toggle = reader.getByRole('button', { name: 'Unfold block', exact: true });
        await toggle.evaluate(element => {
          const container = element.closest('.app-scroll-container');
          container.scrollTop += element.getBoundingClientRect().top - 300;
        });
        const before = await reader.locator('.app-scroll-container').evaluate(element => element.scrollTop);
        assert.ok(before > 500, 'the example starts well below the top of the note');
        await toggle.tap();
        await reader.getByRole('button', { name: 'Fold block', exact: true }).waitFor();
        await reader.waitForTimeout(400);
        const after = await reader.locator('.app-scroll-container').evaluate(element => element.scrollTop);
        assert.ok(Math.abs(after - before) < 2, `Unfold jumped from ${before} to ${after}`);
        assert.equal(await reader.locator('.tiptap').evaluate(element => element === document.activeElement), false);
        assert.equal(await reader.getByText('Hidden solution', { exact: true }).isVisible(), true);
      } finally { await reader.close(); }
    });
    // Exercise real DOM input/selection and the public native occlusion bridge.
    // These cases own visibility and minimum movement, rather than scroll internals.
    for (const [name, scenario] of [
      ['typing, Enter, deletion and paste stay minimally above keyboard plus bar', 'typing'],
      ['formatting bar toggles and growing floating keyboard occlusion preserve the caret', 'insets'],
      ['word selection leaves a visible middle word still and minimally reveals a hidden end', 'selection'],
      ['inserting a final paragraph reveals it without centering', 'paragraph'],
      ['PDF quote insertion at the note end reveals immediately with ordinary motion enabled', 'quote'],
    ]) await t.test(name, async () => {
      const scrollPage = await context.newPage();
      try {
        await scrollPage.setViewportSize({ width: 430, height: 932 });
        await scrollPage.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await scrollPage.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        const moduleId = 'scroll-' + scenario;
        await scrollPage.evaluate(id => window.memnoterEditor.open(id), moduleId);
        await scrollPage.locator('.tiptap').click();
        await scrollPage.keyboard.insertText(('Middle word selection stays here. '.repeat(4) + '\n').repeat(45) + 'Final line');
        const settle = () => scrollPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = () => scrollPage.evaluate(() => {
          const selection = getSelection();
          const range = selection.getRangeAt(0).cloneRange();
          range.collapse(selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset);
          let rect = range.getBoundingClientRect();
          // WebKit gives an empty paragraph's collapsed range no box.
          if (!rect.height) rect = (selection.focusNode.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode.parentElement).getBoundingClientRect();
          const container = document.querySelector('.app-scroll-container');
          return { scroll: container.scrollTop, top: rect.top, bottom: rect.bottom,
            visibleBottom: container.getBoundingClientRect().bottom - Number(container.dataset.bottomInset || 0) };
        });
        const visible = async (previous, label) => {
          await scrollPage.waitForFunction(() => {
            const selection = getSelection();
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            const container = document.querySelector('.app-scroll-container');
            return !rect.height || rect.bottom <= container.getBoundingClientRect().bottom - Number(container.dataset.bottomInset || 0) - 23;
          });
          await settle();
          const next = await geometry();
          assert.ok(next.bottom <= next.visibleBottom - 24 + 1, `${label}: hidden caret ${JSON.stringify(next)}`);
          if (previous && next.scroll > previous.scroll + 1) {
            assert.ok(next.bottom >= next.visibleBottom - 27, `${label}: centered instead of minimum reveal ${JSON.stringify({ previous, next })}`);
          }
          return next;
        };
        await scrollPage.evaluate(() => window.memnoterEditor.setBottomInset(336 + 76));
        await scrollPage.waitForTimeout(150);
        await visible(null, 'keyboard opening');
        if (scenario === 'typing') {
          // Put the final caret at the visibility boundary before individual input.
          await scrollPage.evaluate(() => {
            const rect = getSelection().getRangeAt(0).getBoundingClientRect();
            const container = document.querySelector('.app-scroll-container');
            container.scrollTop += rect.bottom - (container.getBoundingClientRect().bottom - 412 - 24);
          });
          let previous = await geometry();
          for (const [index, character] of [...'abcdefghijklmnopqrstuvwxyz0123456789'].entries()) {
            await scrollPage.keyboard.type(character);
            previous = await visible(previous, `keystroke ${index}`);
            if (index % 6 === 5) {
              await scrollPage.keyboard.press('Enter');
              previous = await visible(previous, `Enter ${index}`);
            }
          }
          await scrollPage.keyboard.press('Backspace');
          previous = await visible(previous, 'Backspace');
          await scrollPage.keyboard.insertText('Pasted text '.repeat(25));
          await visible(previous, 'paste');
        } else if (scenario === 'insets') {
          for (const inset of [336, 412, 336, 180, 480, 412]) {
            const previous = await geometry();
            await scrollPage.evaluate(inset => window.memnoterEditor.setBottomInset(inset), inset);
            await visible(previous, `occlusion ${inset}`);
            await scrollPage.keyboard.type('x');
            await visible(null, 'typing after inset');
          }
        } else if (scenario === 'selection') {
          const paragraph = scrollPage.locator('.tiptap p').nth(20);
          await paragraph.evaluate(node => {
            const container = node.closest('.app-scroll-container');
            container.scrollTop += node.getBoundingClientRect().top - 220;
          });
          await settle();
          const before = await geometry();
          await paragraph.dblclick({ position: { x: 40, y: 12 } });
          await settle();
          assert.ok((await scrollPage.evaluate(() => getSelection().toString())).length > 0);
          assert.ok(Math.abs((await geometry()).scroll - before.scroll) < 1, 'Double-click jumped away from the middle word');
          // Selection can change under an existing keyboard (e.g. drag handles).
          await paragraph.evaluate(node => {
            const container = node.closest('.app-scroll-container');
            container.scrollTop += node.getBoundingClientRect().top - 560;
            const range = document.createRange();
            const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
            range.setStart(text, 0); range.setEnd(text, 6);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          });
          const hidden = await geometry();
          await settle();
          const after = await geometry();
          const expected = hidden.bottom - (hidden.visibleBottom - 24);
          assert.ok(Math.abs(after.scroll - hidden.scroll - expected) <= 2, `Hidden selection must reveal minimally: ${JSON.stringify({ hidden, after, expected })}`);
        } else if (scenario === 'quote') {
          await scrollPage.emulateMedia({ reducedMotion: 'no-preference' });
          await scrollPage.evaluate(async moduleId => {
            const { pendingPdfQuote } = await import('/src/lib/pending-pdf-quote.ts');
            pendingPdfQuote.setState(() => ({ id: 'scroll-quote', moduleId, kind: 'text', status: 'draft',
              parts: [{ text: 'Inserted quote at the very end of the long note. '.repeat(5),
                source: { documentId: 'source-pdf', name: 'Source.pdf', page: 1, region: { x: 0, y: 0, width: 1, height: 1 } } }] }));
          }, moduleId);
          await scrollPage.evaluate(() => { document.querySelector('.app-scroll-container').scrollTop -= 120; });
          await scrollPage.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
          await settle();
          const quote = await scrollPage.locator('.tiptap .node-pdfTextQuote').boundingBox();
          const after = await geometry();
          assert.ok(quote && quote.y >= 0 && quote.y + quote.height <= after.visibleBottom - 23, `Inserted quote hidden: ${JSON.stringify({ quote, after })}`);
          const position = after.scroll;
          await scrollPage.waitForTimeout(180);
          assert.ok(Math.abs((await geometry()).scroll - position) < 1, 'Quote reveal continued animating');
        } else {
          await scrollPage.evaluate(() => { document.querySelector('.app-scroll-container').scrollTop -= 120; });
          const previous = await geometry();
          await scrollPage.keyboard.press('Enter');
          await scrollPage.keyboard.insertText('Inserted final paragraph');
          await visible(previous, 'final insertion');
        }
      } finally { await scrollPage.close(); }
    });
    for (const gesture of ['touch', 'wheel']) await t.test(`${gesture} reading and momentum ignore stale selections and inset reveals`, async () => {
      const reader = await context.newPage();
      try {
        await reader.setViewportSize({ width: 430, height: 932 });
        await reader.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await reader.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        await reader.evaluate(() => window.memnoterEditor.open('finger-' + Date.now()));
        await reader.locator('.tiptap').click();
        await reader.keyboard.insertText(Array.from({ length: 100 }, (_, i) => `Field observation ${i}: the river path remains open after the rain.`).join('\n'));
        await reader.waitForTimeout(400);
        const result = await reader.evaluate(async gesture => {
          const c = document.querySelector('.app-scroll-container');
          const editor = document.querySelector('.tiptap');
          // A retained word selection is valid even with the keyboard dismissed.
          const r = document.createRange(); r.selectNodeContents(editor.querySelector('p'));
          getSelection().removeAllRanges(); getSelection().addRange(r); editor.blur();
          await new Promise(resolve => setTimeout(resolve, 200));
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
          const writes = [], positions = [];
          const original = c.scrollTo;
          Object.defineProperty(c, 'scrollTop', { configurable: true, get() { return descriptor.get.call(this); }, set(value) { writes.push(value); descriptor.set.call(this, value); } });
          c.scrollTo = function(...args) { writes.push(args); return original.apply(this, args); };
          try {
            if (gesture === 'touch') c.dispatchEvent(new Event('touchstart', { bubbles: true }));
            for (let i = 0; i < 18; i++) {
              if (gesture === 'wheel') c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 35 }));
              // Stand in for WebKit's compositor scroll, bypassing the writer probe.
              descriptor.set.call(c, 400 + i * 35);
              c.dispatchEvent(new Event('scroll'));
              if (i === 4 && gesture === 'touch') {
                c.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
                document.dispatchEvent(new Event('touchend', { bubbles: true }));
              }
              window.memnoterEditor.setBottomInset(i % 2 ? 0 : 76);
              document.dispatchEvent(new Event('selectionchange'));
              window.dispatchEvent(new Event('resize'));
              await new Promise(resolve => setTimeout(resolve, 35));
              positions.push(c.scrollTop);
            }
            await new Promise(resolve => setTimeout(resolve, 450));
            positions.push(c.scrollTop);
            return { writes, positions };
          } finally { delete c.scrollTop; c.scrollTo = original; }
        }, gesture);
        assert.deepEqual(result.writes, [], `Reader gesture triggered programmatic writes: ${JSON.stringify(result)}`);
        assert.ok(result.positions.every((value, i, values) => i === 0 || value >= values[i - 1]), `Reading reversed direction: ${result.positions}`);
      } finally { await reader.close(); }
    });
    await t.test('late Mermaid rendering above the viewport preserves the reading line through momentum', async () => {
      const reader = await context.newPage();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      try {
        await reader.setViewportSize({ width: 430, height: 932 });
        await reader.route(/pele/, async route => { await gate; await route.continue(); });
        await reader.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await reader.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        await reader.evaluate(() => window.memnoterEditor.open('lazy-finger'));
        await reader.locator('.tiptap').click();
        // The public editor receives a real rich clipboard document.
        await reader.evaluate(() => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/html', '<p>Trail survey</p><pre><code class="language-mermaid">graph TD\nA[Trailhead] --&gt; B[River]\nB --&gt; C[Bridge]\nC --&gt; D[Camp]\nD --&gt; E[Summit]</code></pre>' + Array.from({ length: 90 }, (_, i) => `<p>Reading anchor ${i}: water levels and route observations.</p>`).join(''));
          document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
        });
        await reader.locator('.mermaid-block').waitFor();
        await reader.evaluate(() => {
          document.querySelector('.tiptap').blur();
          const c = document.querySelector('.app-scroll-container');
          c.dispatchEvent(new Event('touchstart', { bubbles: true }));
          c.scrollTop = 650;
          window.readingAnchor = [...document.querySelectorAll('.tiptap p')].find(p => p.getBoundingClientRect().top > 100);
          window.anchorBefore = window.readingAnchor.getBoundingClientRect().top;
          document.dispatchEvent(new Event('touchend', { bubbles: true }));
        });
        release();
        // Continue momentum while the renderer completes; layout must stay still.
        const samples = [];
        for (let i = 0; i < 15; i++) {
          samples.push(await reader.evaluate(() => {
            document.querySelector('.app-scroll-container').dispatchEvent(new Event('scroll'));
            return window.readingAnchor.getBoundingClientRect().top - window.anchorBefore;
          }));
          await reader.waitForTimeout(40);
        }
        await reader.locator('.mermaid-preview svg').waitFor();
        samples.push(await reader.evaluate(() => window.readingAnchor.getBoundingClientRect().top - window.anchorBefore));
        assert.ok(samples.every(delta => Math.abs(delta) <= 1), `Lazy diagram shifted the reading line: ${samples}`);
      } finally { release(); await reader.close(); }
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
    await t.test('touch focus cannot reveal a retained caret before the delayed tap hit-test', async () => {
      const tapPage = await context.newPage();
      try {
        await tapPage.setViewportSize({ width: 414, height: 896 });
        await tapPage.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await tapPage.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        await tapPage.evaluate(() => window.memnoterEditor.open('delayed-tap'));
        await tapPage.locator('.tiptap').click();
        await tapPage.keyboard.insertText(Array.from({ length: 70 }, (_, i) => `Line ${i + 1} keyboard opening verification`).join('\n'));
        await tapPage.evaluate(() => {
          document.activeElement.blur();
          document.querySelector('.app-scroll-container').scrollTop = 0;
        });
        await tapPage.waitForTimeout(150);
        const target = await tapPage.evaluate(() => {
          const editor = document.querySelector('.tiptap');
          const container = editor.closest('.app-scroll-container');
          // Standalone WebKit may pan on HTMLElement.focus itself. Establish
          // focus before the reader position; inject iOS's later notification
          // separately so this case isolates our reveal writers.
          editor.focus({ preventScroll: true });
          container.scrollTop = 0;
          const line = [...editor.querySelectorAll('p')].find(p => {
            const r = p.getBoundingClientRect(); return r.top > innerHeight * 0.75 && r.bottom < innerHeight - 30;
          });
          const range = document.createRange();
          range.setStart(line.firstChild, 16); range.setEnd(line.firstChild, 17);
          const box = range.getBoundingClientRect();
          const x = box.left + 1, y = box.top + box.height / 2;
          const hit = document.caretRangeFromPoint(x, y);
          // iOS emits focus between pointerup and compatibility mouse/click
          // events, while the DOM still contains the old offscreen selection.
          // Reproduce that observed ordering; leave final placement to WebKit.
          const before = container.scrollTop;
          editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
          editor.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
          editor.dispatchEvent(new FocusEvent('focus'));
          return { x, y, text: hit.startContainer.textContent, offset: hit.startOffset, scroll: before };
        });
        await tapPage.waitForTimeout(60);
        assert.equal(await tapPage.locator('.app-scroll-container').evaluate(c => c.scrollTop), target.scroll,
          'focus must not move content before WebKit resolves the tap');
        await tapPage.mouse.click(target.x, target.y);
        const readSelection = () => tapPage.evaluate(() => ({ text: getSelection().focusNode.textContent, offset: getSelection().focusOffset }));
        assert.deepEqual(await readSelection(), { text: target.text, offset: target.offset }, 'WebKit must hit the original character');
        for (const inset of [80, 180, 336, 412]) {
          await tapPage.evaluate(inset => window.memnoterEditor.setBottomInset(inset), inset);
          await tapPage.waitForTimeout(30);
        }
        await tapPage.waitForTimeout(250);
        assert.deepEqual(await readSelection(), { text: target.text, offset: target.offset }, 'inset reveal preserves the tapped character');
        const geometry = await tapPage.evaluate(() => {
          const c = document.querySelector('.app-scroll-container');
          return { bottom: getSelection().getRangeAt(0).getBoundingClientRect().bottom,
            limit: c.getBoundingClientRect().bottom - 412 - 24 };
        });
        assert.ok(Math.abs(geometry.bottom - geometry.limit) <= 2, `tap reveals minimally: ${JSON.stringify(geometry)}`);
        // Repeated focus notifications must preserve an already placed selection.
        await tapPage.evaluate(() => {
          const editor = document.querySelector('.tiptap');
          editor.dispatchEvent(new FocusEvent('focus'));
          editor.dispatchEvent(new FocusEvent('focus'));
        });
        await tapPage.waitForTimeout(60);
        assert.deepEqual(await readSelection(), { text: target.text, offset: target.offset });
      } finally { await tapPage.close(); }
    });
    // A blurred editor can retain a completely different model caret. Start
    // at the actual scroll limit and use taps before native reports occlusion.
    for (const [device, width, height, keyboard] of [['iPhone 11', 414, 896, 336], ['iPad', 820, 1180, 400]]) {
      for (const scenario of ['last caret', 'bar-only line', 'below end', 'late opening', 'visible line']) {
        await t.test(`${device}: hidden keyboard tap ${scenario} reveals once with trailing room`, async () => {
          const tapPage = await context.newPage();
          try {
            await tapPage.setViewportSize({ width, height });
            await tapPage.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
            await tapPage.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
            await tapPage.evaluate(() => window.memnoterEditor.open('tap-opening'));
            await tapPage.locator('.tiptap').click();
            await tapPage.keyboard.insertText(Array.from({ length: 70 }, (_, i) => `Line ${i + 1} keyboard opening verification`).join('\n'));
            // Retain a stale caret at the start before dismissing the keyboard.
            await tapPage.keyboard.press('Control+Home');
            await tapPage.evaluate(() => {
              document.activeElement.blur();
              window.memnoterEditor.setBottomInset(0);
              const container = document.querySelector('.app-scroll-container');
              container.scrollTop = container.scrollHeight;
            });
            await tapPage.waitForTimeout(100);
            const target = await tapPage.evaluate(({ scenario, height, keyboard }) => {
              const container = document.querySelector('.app-scroll-container');
              let line = document.querySelector('.tiptap p:last-child');
              if (scenario === 'bar-only line' || scenario === 'visible line') {
                line = [...document.querySelectorAll('.tiptap p')].find(p => {
                  const r = p.getBoundingClientRect();
                  return scenario === 'bar-only line' ? r.top > height - keyboard - 76 && r.bottom < height - keyboard - 24
                    : r.top > height - keyboard - 180 && r.bottom < height - keyboard - 120;
                });
              }
              const range = document.createRange();
              range.selectNodeContents(line);
              const box = range.getClientRects()[0];
              const y = scenario === 'below end' ? document.querySelector('.tiptap').getBoundingClientRect().bottom + 8 : box.top + box.height / 2;
              window.tapScrolls = [container.scrollTop];
              container.addEventListener('scroll', () => {
                if (container.scrollTop !== window.tapScrolls.at(-1)) window.tapScrolls.push(container.scrollTop);
              });
              const x = box.left + 65;
              const hit = document.caretRangeFromPoint(x, y);
              return { x, y, hitText: hit.startContainer.textContent,
                before: container.scrollTop, max: container.scrollHeight - container.clientHeight };
            }, { scenario, height, keyboard });
            assert.ok(Math.abs(target.before - target.max) <= 1, 'reader starts at max scroll');
            if (scenario === 'last word') await tapPage.mouse.dblclick(target.x, target.y);
            else await tapPage.touchscreen.tap(target.x, target.y);
            const placed = await tapPage.evaluate(() => ({ text: getSelection().focusNode.textContent, offset: getSelection().focusOffset }));
            if (scenario === 'late opening') await tapPage.waitForTimeout(450);
            const steps = scenario === 'stepped opening' ? [80, 180, keyboard, keyboard + 76] : [keyboard + 76];
            if (scenario === 'stepped opening') {
              // Schedule the animation in the browser. Round trips through Node
              // can stretch a 30ms gap past the production 100ms quiet window.
              await tapPage.evaluate(async steps => {
                for (const inset of steps) {
                  window.memnoterEditor.setBottomInset(inset);
                  await new Promise(resolve => setTimeout(resolve, 30));
                }
              }, steps);
              await tapPage.waitForFunction(() => {
                const container = document.querySelector('.app-scroll-container');
                const rect = getSelection().getRangeAt(0).getClientRects()[0];
                const limit = container.getBoundingClientRect().bottom - Number(container.dataset.bottomInset) - 24;
                return rect && rect.bottom <= limit + 1 && rect.bottom >= limit - 2;
              });
            } else {
              for (const inset of steps) {
                await tapPage.evaluate(inset => window.memnoterEditor.setBottomInset(inset), inset);
                await tapPage.waitForTimeout(30);
              }
              await tapPage.waitForTimeout(250);
            }
            const result = await tapPage.evaluate(() => {
              const container = document.querySelector('.app-scroll-container');
              const selection = getSelection();
              const range = selection.rangeCount ? selection.getRangeAt(0) : null;
              const rect = range?.getClientRects()[0];
              return { focused: document.activeElement === document.querySelector('.tiptap'),
                text: selection.toString(), node: (selection.focusNode?.parentElement?.closest('p') ?? selection.focusNode)?.textContent,
                end: selection.focusOffset, collapsed: selection.isCollapsed,
                bottom: rect?.bottom, limit: container.getBoundingClientRect().bottom - Number(container.dataset.bottomInset) - 24,
                max: container.scrollHeight - container.clientHeight, scroll: container.scrollTop, movements: window.tapScrolls };
            });
            assert.equal(result.focused, true, `tap must focus editor: ${JSON.stringify(result)}`);
            assert.ok(result.node?.includes(['bar-only line', 'visible line'].includes(scenario) ? 'keyboard opening' : 'Line 70'), `tap must retain intended line: ${JSON.stringify(result)}`);
            if (!['last word', 'below end'].includes(scenario)) {
              assert.equal(result.node, target.hitText, 'tap must hit the original text');
              // Touch hit-testing can snap to a word boundary rather than the
              // nearest glyph. Preserve WebKit's placed offset through layout.
              assert.equal(result.end, placed.offset, 'occlusion must preserve WebKit’s placed character');
              assert.equal(result.node, placed.text);
            }
            if (scenario === 'last word') assert.ok(result.text.length > 0, 'double tap selects word');
            if (scenario === 'below end') assert.equal(result.end, result.node.length, 'blank area places caret at note end');
            assert.ok(result.bottom <= result.limit + 1, `caret is covered: ${JSON.stringify(result)}`);
            if (scenario !== 'visible line') assert.ok(result.bottom >= result.limit - 2, `reveal must be minimal: ${JSON.stringify(result)}`);
            assert.ok(result.max > target.max, 'occlusion must grow trailing scroll range');
            assert.ok(result.movements.length <= (scenario === 'visible line' ? 1 : 2), `one tap must move at most once: ${JSON.stringify(result)}`);
            assert.ok(result.movements.every((v, i, values) => i === 0 || v >= values[i - 1]), 'no reverse correction');
          } finally { await tapPage.close(); }
        });
      }
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
    await t.test('native review reveal selects the whole block when no sentence punctuation exists', async () => {
      const reveal = await context.newPage();
      try {
        await reveal.goto(`http://localhost:${server.httpServer.address().port}/editor.html`);
        await reveal.waitForFunction(() => window.messages.some(m => m.event === 'ready'));
        await reveal.evaluate(() => window.memnoterEditor.open('reveal'));
        await reveal.locator('.tiptap').click();
        await reveal.keyboard.insertText('First {{Paris}} then {{London}}');
        const cardId = await reveal.locator('[data-card-id]').getAttribute('data-card-id');
        await reveal.evaluate(id => window.memnoterEditor.revealCard('reveal', `${id}:c2`), cardId);
        await reveal.waitForFunction(() => getSelection()?.toString() === 'First {{Paris}} then {{London}}');
      } finally { await reveal.close(); }
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
    // visible caret still, and reveal an occluded caret to the visible edge with clearance.
    const settleScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const caretGeometry = () => page.evaluate(() => {
      const range = window.getSelection().getRangeAt(0).cloneRange();
      range.collapse(false);
      const rect = range.getBoundingClientRect();
      const container = document.querySelector('.app-scroll-container');
      const top = container.getBoundingClientRect().top + container.clientTop + Number(container.dataset.topInset ?? 0);
      const bottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - Number(container.dataset.bottomInset ?? 0);
      return { scroll: container.scrollTop, caret: (rect.top + rect.bottom) / 2, bottom: rect.bottom, visibleBottom: bottom, top };
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
    assert.ok(revealed.bottom <= revealed.visibleBottom - 23 && revealed.bottom >= revealed.visibleBottom - 27, JSON.stringify(revealed));
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
    await page.getByRole('button', { name: 'Image actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Alt text and title', exact: true }).click();
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
