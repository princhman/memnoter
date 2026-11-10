#!/usr/bin/env node
// Own the worker for the whole test run, and exercise auth/DO setup before XCTest.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: ios-test-with-worker.mjs <command> [args...]');
const root = resolve(import.meta.dirname, '..');
const output = process.env.RUNNER_TEMP || '/tmp';
mkdirSync(output, { recursive: true });
const logPath = resolve(output, 'wrangler.log');
// Refuse an existing listener: otherwise a stale worker can satisfy readiness.
try {
  await fetch('http://127.0.0.1:8787', { signal: AbortSignal.timeout(1000) });
  throw new Error('Port 8787 is already in use; stop the existing sync worker first');
} catch (error) {
  if (error.message.startsWith('Port 8787')) throw error;
}
const fd = openSync(logPath, 'w');
const worker = spawn('pnpm', ['--dir', 'apps/sync', 'exec', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787'], {
  cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
});
closeSync(fd);
let workerError;
worker.on('error', error => { workerError = error; });
let tests;
const stop = () => {
  if (worker.pid) { try { process.kill(-worker.pid, 'SIGTERM'); } catch {} }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { tests?.kill(signal); stop(); process.exit(1); });
try {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (true) {
    if (workerError || worker.exitCode !== null) throw workerError || new Error(`Worker exited: ${worker.exitCode}`);
    try {
      const response = await fetch('http://127.0.0.1:8787/v1/auth/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `ios-readiness-${Date.now()}@example.com` }), signal: AbortSignal.timeout(2000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.devCode !== 'string') throw new Error(`Auth readiness: ${response.status} ${JSON.stringify(body)}`);
      break;
    } catch (error) { lastError = error; }
    if (Date.now() >= deadline) throw new Error('Worker auth did not become ready', { cause: lastError });
    await delay(250);
  }
  console.log('Local worker auth is ready; starting iOS tests');
  tests = spawn(command, args, { cwd: root, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    tests.on('error', reject);
    tests.on('exit', code => resolve(code ?? 1));
    worker.on('exit', () => { tests.kill('SIGTERM'); resolve(1); });
  });
} catch (error) {
  console.error(error);
  console.error(readFileSync(logPath, 'utf8'));
  process.exitCode = 1;
} finally { stop(); }
