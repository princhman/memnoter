import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('live permissions and URL appear only in opted-in Debug products, including after reuse', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(`${tmpdir()}/ios-live-plist-`);
  const build = (configuration, url) => {
    execFileSync('bash', ['scripts/ios-live-plist.sh'], { env: { ...process.env, DERIVED_FILE_DIR: directory, CONFIGURATION: configuration, MEMNOTER_EDITOR_DEV_URL: url } });
    return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', `${directory}/LiveEditor.plist`], { encoding: 'utf8' }));
  };
  try {
    const live = build('Debug', 'http://192.168.1.10:1420');
    assert.equal(live.MemnoterEditorDevURL, 'http://192.168.1.10:1420');
    assert.equal(live.NSAppTransportSecurity.NSAllowsArbitraryLoadsInWebContent, true);
    assert.ok(live.NSLocalNetworkUsageDescription);
    assert.deepEqual(build('Release', 'http://192.168.1.10:1420'), {});
    build('Debug', 'http://192.168.1.10:1420');
    assert.deepEqual(build('Debug', ''), {});
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
