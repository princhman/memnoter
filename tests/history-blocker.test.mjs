import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const routerRequire = createRequire(require.resolve('@tanstack/react-router'));
const { createBrowserHistory } = routerRequire('@tanstack/history');

// A browser session stack: go() changes its index and asynchronously emits POP.
// Rollback decisions belong entirely to the real history dependency.
function browserStack(start) {
  let index = start;
  const entries = ['/a', '/b', '/c', '/d'];
  const listeners = new Map();
  const win = {
    location: { get pathname() { return entries[index]; }, search: '', hash: '' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    history: {
      length: entries.length,
      get state() { return { __TSR_index: index, __TSR_key: String(index) }; },
      pushState() {}, replaceState() {},
      go(delta) {
        const next = index + delta;
        if (next < 0 || next >= entries.length) return;
        index = next;
        queueMicrotask(() => listeners.get('popstate')?.());
      },
    },
  };
  return win;
}

for (const delta of [-2, -1, 1, 2]) {
  test(`blocked POP ${delta} restores both browser URL and router location`, async () => {
    const originalDocument = globalThis.document;
    globalThis.document = {};
    const win = browserStack(delta < 0 ? 2 : 1);
    const history = createBrowserHistory({ window: win });
    const original = win.location.pathname;
    history.block({ blockerFn: async () => true, enableBeforeUnload: false });
    try {
      win.history.go(delta);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(win.location.pathname, original);
      assert.equal(history.location.pathname, original);
    } finally {
      history.destroy();
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    }
  });
}
