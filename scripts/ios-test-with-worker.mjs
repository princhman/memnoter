#!/usr/bin/env node
// Own the worker for the whole test run, and exercise auth/DO setup before XCTest.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: ios-test-with-worker.mjs <command> [args...]');
const root = resolve(import.meta.dirname, '..');
const output = process.env.RUNNER_TEMP || '/tmp';
mkdirSync(output, { recursive: true });
const logPath = resolve(output, 'wrangler.log');
// Refuse an existing listener: otherwise a stale worker can satisfy readiness.
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', error => reject(new Error('Port 8787 is unavailable; stop any existing sync worker first', { cause: error })));
  probe.listen(8787, '127.0.0.1', () => probe.close(resolve));
});
const fd = openSync(logPath, 'w');
const worker = spawn('pnpm', ['--dir', 'apps/sync', 'exec', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787'], {
  cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
});
closeSync(fd);
let workerError;
let workerExited = false;
worker.on('exit', () => { workerExited = true; });
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
    if (workerError || workerExited) throw workerError || new Error(`Worker exited: ${worker.exitCode}`);
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
    tests.on('exit', code => resolve(workerExited ? 1 : (code ?? 1)));
    worker.on('exit', () => {
      if (tests.exitCode !== null || tests.signalCode !== null) return;
      console.error('Sync worker exited during tests');
      console.error(readFileSync(logPath, 'utf8'));
      tests.kill('SIGTERM');
      // Keep ownership until the test process actually exits.
      process.exitCode = 1;
    });
  });
} catch (error) {
  console.error(error);
  console.error(readFileSync(logPath, 'utf8'));
  process.exitCode = 1;
} finally { stop(); }
