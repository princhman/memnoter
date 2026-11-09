import { readdir, readFile } from 'node:fs/promises';

// Ship PDF.js's optional decoding and font data locally, including offline use.
export function pdfAssets() {
  const root = new URL('./node_modules/pdfjs-dist/', import.meta.url);
  const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  return {
    name: 'local-pdf-assets',
    async generateBundle() {
      for (const folder of folders) {
        for (const name of await readdir(new URL(`${folder}/`, root))) {
          if (/\.(bcmap|pfb|ttf|wasm|icc)$/.test(name)) {
            this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: await readFile(new URL(`${folder}/${name}`, root)) });
          }
        }
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/);
        if (!match) return next();
        try {
          const bytes = await readFile(new URL(`${match[1]}/${match[2]}`, root));
          res.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          res.end(bytes);
        } catch { next(); }
      });
    },
  };
}
