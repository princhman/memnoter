import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, contents) => writeFileSync(resolve(root, path), contents);
const { version } = JSON.parse(read('package.json'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric app version (major.minor.patch)');

// XcodeGen runs this before generation, including for local builds.
write('apps/ios/Version.xcconfig', `// Generated from package.json; do not edit.\nMARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = 1\n`);
if (!process.argv.includes('--ios-only')) {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  config.version = version;
  write('src-tauri/tauri.conf.json', `${JSON.stringify(config, null, 2)}\n`);
  for (const path of ['src-tauri/Cargo.toml', 'crates/memnoter-core/Cargo.toml', 'crates/memnoter-ffi/Cargo.toml']) {
    write(path, read(path).replace(/^version = "[^"]+"/m, `version = "${version}"`));
  }
  write('Cargo.lock', read('Cargo.lock').replace(/(name = "memnoter(?:-core|-ffi)?"\nversion = ")[^"]+/g, `$1${version}`));
  // Retained Tauri-generated iOS project (the native iPad app lives in apps/ios).
  write('src-tauri/gen/apple/project.yml', read('src-tauri/gen/apple/project.yml')
    .replace(/CFBundleShortVersionString: .*/, `CFBundleShortVersionString: ${version}`)
    .replace(/CFBundleVersion: .*/, `CFBundleVersion: "${version}"`));
  write('src-tauri/gen/apple/memnoter_iOS/Info.plist', read('src-tauri/gen/apple/memnoter_iOS/Info.plist')
    .replace(/(<key>CFBundle(?:ShortVersionString|Version)<\/key>\s*<string>)[^<]+/g, `$1${version}`));
}
