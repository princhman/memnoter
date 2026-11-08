import { browserHarness } from "./support/browser.mjs";

import { test } from "node:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { createServer, webkit } = browserHarness(import.meta.url);

const folder = process.env.LARGE_NOTE_FOLDER ?? fileURLToPath(new URL("./fixtures/Vault/", import.meta.url));
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const summary = values => ({ p50: +percentile(values, .5).toFixed(2), p95: +percentile(values, .95).toFixed(2) });
test("real imported note WebKit input-to-paint benchmark", { skip: !existsSync(folder), timeout: 240_000 }, async () => {
  const entries = [];
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${relative}/`);
      else entries.push({ path: relative, ...(/\.md$/i.test(relative) ? { text: await readFile(path.join(dir, entry.name), "utf8") } : {}) });
    }
  }
  await walk(folder);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = await createServer({ root, logLevel: "error", server: { port: 0, strictPort: false, hmr: false, watch: null }, plugins: [{ name: "read-only-course-assets", configureServer(server) {
    server.middlewares.use("/course-asset", async (req, res) => {
      const relative = new URL(req.url, "http://localhost").searchParams.get("path");
      if (!entries.some(entry => entry.path === relative)) { res.statusCode = 404; res.end(); return; }
      res.end(await readFile(path.join(folder, relative)));
    });
  } }] });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on("pageerror", error => console.error(error));
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/large-note.html`);
    await page.waitForFunction(() => !!window.openLargeNote);
    const openings = [];
    let stats;
    for (let i = 0; i < 5; i++) {
      stats = await page.evaluate(folder => window.openLargeNote(folder), { name: path.basename(folder), entries });
      openings.push(stats.opening);
      await page.waitForTimeout(150);
    }
    stats.opening = summary(openings);
    await page.waitForTimeout(1000);
    await page.evaluate(() => timings.clear());
    const results = {};
    for (const [label, fraction] of [["middle", .5], ["end", .98]]) {
      await page.evaluate(async fraction => {
        editor.commands.setTextSelection(positions[Math.floor(positions.length * fraction)]);
        editor.commands.focus(); editor.commands.scrollIntoView(); await paint();
      }, fraction);
      for (const action of ["typing", "Enter", "selection", "scroll"]) {
        const values = [];
        for (let i = 0; i < 25; i++) {
          if (action !== "scroll") await page.evaluate(() => { window.inputPaint = undefined; document.addEventListener("keydown", () => { const start = performance.now(); window.inputPaint = paint().then(() => performance.now() - start); }, { once: true, capture: true }); });
          if (action === "typing") await page.keyboard.type("x");
          else if (action === "Enter") await page.keyboard.press("Enter");
          else if (action === "selection") await page.keyboard.press("Shift+ArrowRight");
          else await page.evaluate(delta => { const start = performance.now(); document.getElementById("root").scrollTop += delta; window.inputPaint = paint().then(() => performance.now() - start); }, i % 2 ? -100 : 100);
          values.push(await page.evaluate(async () => window.inputPaint));
        }
        results[`${label}:${action}`] = summary(values);
      }
    }
    const plugins = await page.evaluate(() => [...timings].map(([name, values]) => ({ name, calls: values.length, total: values.reduce((a,b) => a+b,0), p95: [...values].sort((a,b) => a-b)[Math.ceil(values.length*.95)-1] })).sort((a,b) => b.total-a.total).slice(0,20));
    const background = await page.evaluate(() => window.profileBackground());
    background.samples = Object.fromEntries(Object.entries(background.samples).map(([name, values]) => [name, summary(values)]));
    console.log(JSON.stringify({ stats, results, plugins, background }, null, 2));
  } finally { await browser?.close(); await server.close(); }
});
