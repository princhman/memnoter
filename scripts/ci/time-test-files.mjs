// Runs each shared-ui test file in its own node:test process, N at a time, and
// writes {file, seconds, ok} per file. Used to measure and to shard by duration.
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';

const concurrency = Number(process.env.CONCURRENCY ?? cpus().length);
const out = process.argv[2] ?? 'test-times.json';
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : readdirSync('tests').filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`);
const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const start = performance.now();
    const ok = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './tests/support/register.mjs', '--test', '--test-reporter=dot', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
      child.on('close', code => { if (code) console.log(`--- FAIL ${file}\n${log.slice(-6000)}`); resolve(code === 0); });
    });
    const seconds = (performance.now() - start) / 1000;
    results.push({ file, seconds: Math.round(seconds * 10) / 10, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${seconds.toFixed(1).padStart(6)}s ${file}`);
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((a, b) => b.seconds - a.seconds);
writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`wall ${((performance.now() - t0) / 1000).toFixed(0)}s, sum ${results.reduce((s, r) => s + r.seconds, 0).toFixed(0)}s, failed ${results.filter(r => !r.ok).length}`);
