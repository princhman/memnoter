import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as viteServer, optimizeDeps } from 'vite';
import { webkit as playwrightWebkit } from 'playwright';

// Serialized into each page before test-specific setup. Call this with just the
// command handler; platform bookkeeping lives here rather than in each fake.
export function installTestBridge({ tauri, native } = {}) {
  if (tauri) {
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback() {},
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      convertFileSrc: path => path,
      ...tauri,
    };
    // Desktop data commands go through one `core` command; fakes see the inner one.
    if (tauri.invoke) {
      const invoke = tauri.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args, options) =>
        command === 'core' ? invoke(args.command, args.args, options) : invoke(command, args, options);
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }
  if (native) window.webkit = { messageHandlers: { memnoter: { postMessage: native } } };
}

export function browserHarness(file) {
  const browsers = new Set();
  return {
    async createServer(options = {}) {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      // Keep caches inside the root so Vite's filesystem sandbox allows them.
      const cacheDir = await mkdtemp(join(root, `node_modules/.test-${basename(file)}-`));
      let server;
      try {
        server = await viteServer({
          root, ...options, cacheDir,
          optimizeDeps: { ...options.optimizeDeps, entries: ['*.html', 'tests/browser/*.html'] },
          server: { ...options.server, hmr: false, watch: null },
        });
        // Finish the full entry scan and prebundle before the first navigation.
        // This avoids newly discovered dependencies invalidating a live page.
        await optimizeDeps(server.config);
      } catch (error) {
        await server?.close();
        await rm(cacheDir, { recursive: true, force: true });
        throw error;
      }
      const close = server.close.bind(server);
      server.close = async () => {
        try { await Promise.all([...browsers].map(browser => browser.close())); await close(); }
        finally { await rm(cacheDir, { recursive: true, force: true }); }
      };
      return server;
    },
    webkit: {
      async launch(options) {
        const browser = await playwrightWebkit.launch(options);
        browsers.add(browser);
        const setup = async target => {
          const addInitScript = target.addInitScript.bind(target);
          const bridge = `window.installTestBridge = ${installTestBridge.toString()};`;
          await addInitScript(bridge);
          // Playwright does not promise ordering between separate init scripts.
          // Include the builder in each callback so setup never races its definition.
          target.addInitScript = (script, arg) => typeof script === 'function'
            ? addInitScript(`${bridge}(${script.toString()})(${JSON.stringify(arg)});`)
            : addInitScript(script, arg);
        };
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async options => { const context = await newContext(options); await setup(context); return context; };
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async options => { const page = await newPage(options); await setup(page); return page; };
        browser.on('disconnected', () => browsers.delete(browser));
        return browser;
      },
    },
  };
}

// Native WebKit selectionchange is delivered separately from keyboard input.
// A completed key press (or a painted frame) does not mean PM has read it yet.
export async function waitForEditorSelection(page) {
  await page.waitForFunction(() => {
    const { view, state } = window.editor;
    const selection = view.dom.ownerDocument.getSelection();
    return view.hasFocus() && selection?.anchorNode && selection.focusNode &&
      view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode) &&
      view.posAtDOM(selection.anchorNode, selection.anchorOffset) === state.selection.anchor &&
      view.posAtDOM(selection.focusNode, selection.focusOffset) === state.selection.head;
  });
}
