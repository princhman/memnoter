import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
register('./support/restore-loader.mjs', import.meta.url);
globalThis.window = { setTimeout, clearTimeout };
const { createFileSync } = await import('../src/lib/sync/files.ts');
const { importKey } = await import('../src/lib/sync/crypto.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

for (const upload of [false, true]) {
  for (const status of [404, 410]) {
    test(`${upload ? 'upload' : 'download'} ${status} ${status === 410 ? 'stops permanently' : 'retries'}`, async t => {
      if (upload && status === 404) t.mock.method(console, "error", () => {});
      let pending = true;
      let attempts = 0;
      let gone = 0;
      globalThis.syncFixture = { call: async (name, args) => {
        switch (name) {
          case 'sync_pending_uploads': return upload && pending ? ['image'] : [];
          case 'sync_pending_deletes': return [];
          case 'sync_missing_files': return !upload && pending ? [{ fileId: 'image', moduleId: 'note', fileType: 'image/png' }] : [];
          case 'read_file': return { bytes: [42] };
          case 'sync_file_gone':
            assert.deepEqual(args, { fileId: 'image', generation: 'epoch' });
            pending = false; gone++; return;
          default: assert.fail(name);
        }
      } };
      globalThis.fetch = async () => { attempts++; return new Response('', { status }); };
      const sync = createFileSync({ generation: 'epoch', server: 'https://mock.local', token: 'token', key: await importKey(btoa('a'.repeat(32))), onStored() { assert.fail('Gone image stored'); }, onUnauthorized() { assert.fail('Unauthorized'); } });
      try {
        sync.request('image');
        await tick();
        sync.request('another');
        await tick();
        assert.equal(attempts, status === 410 ? 1 : 2);
        assert.equal(gone, status === 410 ? 1 : 0);
      } finally { await sync.stop(); }
    });
  }
}
