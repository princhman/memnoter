import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const shard = args.find(arg => arg.startsWith('--test-shard='));
const run = files => spawnSync(process.execPath, [
  '--experimental-strip-types', '--import', './tests/support/register.mjs',
  '--test', '--test-concurrency=2', '--test-timeout=240000', ...files,
], { stdio: 'inherit' }).status ?? 1;

// Never retry failures: a successful rerun must not hide a broken first run.
const status = run(args.some(arg => !arg.startsWith('--')) ? args : [...args, 'tests/*.test.mjs']);
if (status !== 0) process.exit(status);
// The benchmark runs once, including when CI splits the suite into shards.
if (!shard || shard.startsWith('--test-shard=1/')) {
  process.exit(run(['tests/copy-large-note.bench.mjs']));
}
