import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const output = new URL('./dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
for (const name of ['index.html', 'styles.css', 'robots.txt', 'sitemap.xml']) {
  await cp(new URL(name, root), new URL(name, output));
}
for (const [source, target] of [
  ['icon-transparent.png', 'icon.png'],
  ['icon-purple-256.png', 'social-icon.png'],
  ['favicon.ico', 'favicon.ico'],
  ['memnoter-dm-sans-650.ttf', 'brand-font.ttf'],
  ['FONT-LICENSE.txt', 'FONT-LICENSE.txt'],
]) {
  await cp(new URL(`../brand/${source}`, root), new URL(`assets/${target}`, output));
}
await cp(new URL('../src/assets/fonts/InterVariable.woff2', root), new URL('assets/inter.woff2', output));
// Refresh at build time: shipped pages have real links even with JavaScript disabled.
// Fail rather than publish stale or invented installer URLs.
const response = await fetch('https://api.github.com/repos/princhman/memnoter/releases/latest', {
  headers: {
    Accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
  },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Cannot resolve latest release: HTTP ${response.status}`);
const release = await response.json();
const { readFile } = await import('node:fs/promises');
let html = await readFile(new URL('index.html', root), 'utf8');
const formats = { 'mac-arm': /_aarch64\.dmg$/, 'mac-intel': /_x64\.dmg$/, windows: /_x64-setup\.exe$/, linux: /_amd64\.AppImage$/ };
for (const [platform, pattern] of Object.entries(formats)) {
  const asset = release.assets.find(({ name }) => pattern.test(name));
  if (!asset) throw new Error(`Latest release has no ${platform} installer`);
  const url = new URL(asset.browser_download_url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/princhman/memnoter/releases/download/')) {
    throw new Error('Unexpected release asset URL');
  }
  html = html.replaceAll(`{{${platform}}}`, url.href);
}
html = html.replaceAll('{{version}}', release.tag_name.replace(/^v/, ''));
await writeFile(new URL('index.html', output), html);
console.log(`Built ${release.tag_name} → ${fileURLToPath(output)}`);
