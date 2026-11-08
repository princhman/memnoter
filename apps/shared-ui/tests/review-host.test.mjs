import { browserHarness } from "./support/browser.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createServer, webkit } = browserHarness(import.meta.url);

test('WK review host scrolls long questions and revealed answers within its viewport', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
    await page.addInitScript(() => {
      window.__states = [];
      window.__writes = [];
      window.installTestBridge({ native: message => {
        if (message.kind === 'event') {
          if (message.event === 'reviewState') window.__states.push(message.payload);
          return;
        }
        let value = null;
        if (message.command === 'review_card' || message.command === 'undo_review') {
          window.__writes.push(message.command);
          Object.assign(window.__card, message.args.card ?? message.args.previous);
        }
        if (message.command === 'due_cards') value = window.__card ? [structuredClone(window.__card)] : [];
        if (['unindexed_modules', 'unindexed_card_modules'].includes(message.command)) value = [];
        queueMicrotask(() => window.__memnoterBridge.resolve(message.id, value));
      } });
      window.loadCard = async (card, revealed) => {
        window.__card = { moduleId: card.id, moduleName: '', section: [],
          dueAt: Date.now() - 60000, stability: 0, stabilityFast: 0, difficulty: 0,
          scheduledDays: 0, learningStep: 0, state: 0, scheduleStatus: 'new',
          lastReviewAt: null, lapses: 0, fsrsModel: null, ...card };
        await window.memnoterReview.load(card.id + card.reps);
        if (revealed) window.memnoterReview.reveal();
      };
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/review-native.html`);
    await page.waitForFunction(() => window.memnoterReview);
    // The same mounted WK host must follow appearance changes without reloading.
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, colorScheme === 'dark');
      const colors = await page.evaluate(() => ({
        scheme: document.documentElement.style.colorScheme,
        background: getComputedStyle(document.body).backgroundColor,
        foreground: getComputedStyle(document.body).color,
      }));
      assert.equal(colors.scheme, colorScheme);
      assert.equal(colors.background, 'rgba(0, 0, 0, 0)', 'Native background shows through');
    }
    for (const revealed of [false, true]) {
      await page.evaluate(revealed => window.loadCard({
        id: 'long', reps: 0, kind: 'basic',
        front: [{ type: 'text', text: 'Question line\n'.repeat(100) + 'Question end' }],
        back: [{ type: 'text', text: 'Answer line\n'.repeat(100) + 'Answer end' }],
      }, revealed), revealed);
      await page.waitForFunction(revealed => document.querySelectorAll('.card-face').length === (revealed ? 2 : 1), revealed);
      const face = page.locator('.card-face').last();
      await face.waitFor();
      await page.locator('main').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const geometry = await face.evaluate(node => {
        const main = node.closest('main');
        const range = document.createRange();
        range.selectNodeContents(node);
        const last = [...range.getClientRects()].at(-1);
        return { scroll: main.scrollTop, bottom: last.bottom, viewport: innerHeight, pageScroll: scrollY };
      });
      assert.ok(geometry.scroll > 0, 'Long face must scroll internally');
      assert.ok(geometry.bottom <= geometry.viewport - 31, 'Last line must clear bottom padding');
      assert.equal(geometry.pageScroll, 0);
    }
    for (const [id, reps] of [['next', 0], ['next', 1]]) {
      await page.evaluate(({ id, reps }) => window.loadCard({
        id, reps, kind: 'basic',
        front: [{ type: 'text', text: id + reps + '\nQuestion line'.repeat(100) }],
        back: [{ type: 'text', text: 'Answer line\n'.repeat(100) }],
      }, false), { id, reps });
      await page.waitForFunction(({ id, reps }) =>
        document.querySelectorAll('.card-face').length === 1 &&
        document.querySelector('.card-face').textContent.startsWith(id + reps), { id, reps });
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), 0, 'New card attempt starts at the top');
      await page.locator('main').evaluate(node => { node.scrollTop = 300; });
      await page.evaluate(() => window.memnoterReview.reveal());
      await page.waitForFunction(() => document.querySelectorAll('.card-face').length === 2);
      assert.equal(await page.locator('main').evaluate(node => node.scrollTop), 300, 'Reveal preserves reading position');
    }
    // Later-today cards must be loaded even while no card is due now. This
    // exercises the same bridge entry point as Swift's native controls.
    await page.evaluate(() => window.loadCard({
      id: 'later', reps: 0, kind: 'basic', dueAt: Date.now() + 60_000,
      front: [{ type: 'text', text: 'Later today question' }],
      back: [{ type: 'text', text: 'Later today answer' }],
    }, false));
    await page.waitForFunction(() => window.__states.at(-1)?.canShowNow);
    const waiting = await page.evaluate(() => window.__states.at(-1));
    assert.equal(waiting.hasCard, false);
    assert.equal(waiting.laterToday.new, 1);
    assert.equal(waiting.counts.new, 0);
    await page.evaluate(() => window.memnoterReview.showNow());
    await page.getByText('Later today question', { exact: true }).waitFor();
    await page.evaluate(() => window.memnoterReview.reveal());
    await page.getByText('Later today answer', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__states.at(-1)?.intervals.length === 4);
    await page.evaluate(() => window.memnoterReview.rate(4));
    await page.waitForFunction(() => window.__states.at(-1)?.canUndo);
    assert.equal(await page.evaluate(() => window.__states.at(-1).reviewed), 1);
    await page.evaluate(() => window.memnoterReview.undo());
    await page.waitForFunction(() => window.__states.at(-1)?.canRedo);
    const undone = await page.evaluate(() => window.__states.at(-1));
    assert.equal(undone.reviewed, 0);
    assert.equal(undone.laterToday.new, 1);
    assert.equal(undone.canUndo, false);
    await page.evaluate(() => window.memnoterReview.redo());
    await page.waitForFunction(() => window.__states.at(-1)?.canUndo && !window.__states.at(-1)?.canRedo);
    assert.equal(await page.evaluate(() => window.__states.at(-1).reviewed), 1);
    assert.deepEqual(await page.evaluate(() => window.__writes), ['review_card', 'undo_review', 'review_card']);
  } finally {
    await browser?.close();
    await server.close();

  }
});
