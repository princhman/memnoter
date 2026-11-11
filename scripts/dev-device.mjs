import { networkInterfaces } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../apps/shared-ui/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);

const address = process.env.IOS_DEV_HOST || Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
if (!address) throw new Error('No LAN IPv4 address found. Set IOS_DEV_HOST to your Mac LAN address.');
const url = `http://${address}:${process.env.IOS_DEV_PORT || 1420}`;
process.env.MEMNOTER_DEVICE_DEV = '1';
const server = await createServer({ root: 'apps/shared-ui', configFile: 'apps/shared-ui/vite.config.ts', server: { host: '0.0.0.0', port: Number(new URL(url).port), strictPort: true } });
await server.listen();
await mkdir('.ios-live', { recursive: true });
await writeFile('.ios-live/url', `${url}\n`);
console.log(`\nLive iOS editor: ${url}/editor.html\nInstall once: scripts/ios-install.sh --live [--iphone | --all]\nKeep this process running and both devices on the same trusted LAN.\n`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await rm('.ios-live/url', { force: true }); await server.close(); process.exit(); });
