import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHarness } from "./support/browser.mjs";
import { fileURLToPath } from "node:url";
const { createServer, webkit } = browserHarness(import.meta.url);

test("image adaptation preserves ink and hue while removing backgrounds through the Blob API", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen(); browser = await webkit.launch(); const page = await browser.newPage();
    await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/contrast.html`);
    const cases = [
      { background: [255,255,255,255], ink: [0,0,0,255], dark: true },
      { background: [250,250,250,255], ink: [0,0,0,255], dark: false },
      { background: [255,255,255,255], ink: [0,0,128,255], dark: true },
      { background: [255,255,255,255], ink: [128,128,128,255], dark: true },
      { background: [0,0,0,0], ink: [0,0,0,255], dark: false },
      { background: [255,255,255,255], ink: [0,0,0,255], dark: true, strip: true },
    ];
    const results = await page.evaluate(async cases => {
      const { adaptImageHere } = await import('/src/lib/image-adapt.ts');
      return Promise.all(cases.map(async ({ background, ink, dark, strip }) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
        const ctx = canvas.getContext('2d'); const data = ctx.createImageData(8,8);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data.data.set(strip && (y >= 6 || x === 0) ? [235,235,235,255] : background, (y*8+x)*4);
        data.data.set(ink, (3*8+4)*4); ctx.putImageData(data,0,0);
        const source = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const result = await adaptImageHere(source, dark);
        const image = await createImageBitmap(result); ctx.clearRect(0,0,8,8); ctx.drawImage(image,0,0); image.close();
        const pixels = ctx.getImageData(0,0,8,8).data;
        const pixel = i => [...pixels.slice(i*4,i*4+4)];
        return { type: result.type, background: pixel(3*8+2), ink: pixel(3*8+4), strip: pixel(63) };
      }));
    }, cases);
    assert.ok(results.every(r => r.type === 'image/png' && r.background[3] === 0));
    assert.deepEqual(results[0].ink, [255,255,255,255]);
    assert.deepEqual(results[1].ink, [0,0,0,255]);
    const [r,g,b,a] = results[2].ink; assert.ok(b > r && r === g && r > 100 && a === 255);
    assert.ok(Math.abs(results[3].ink[3] - 127) < 3);
    assert.deepEqual(results[4].ink, [0,0,0,255]);
    assert.ok(results[5].strip[3] < 16); assert.deepEqual(results[5].ink, [255,255,255,255]);
  } finally { await browser?.close(); await server.close(); }
});
