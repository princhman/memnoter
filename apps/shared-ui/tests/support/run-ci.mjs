// CI test run: the full suite, then each failing file once more on its own.
// Browser suites are timing-sensitive on loaded CI machines. A file that passes
// alone is reported as flaky in the job summary; one that fails again fails CI.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const node = (args) => spawnSync(process.execPath, [
  '--experimental-strip-types', '--import', './tests/support/register.mjs', '--test', ...args,
], { stdio: 'inherit' }).status;

const failedList = join(mkdtempSync(join(tmpdir(), 'shared-ui-tests-')), 'failed.txt');
const status = node([
  '--test-concurrency=2', '--test-timeout=240000',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=./tests/support/failed-files-reporter.mjs', `--test-reporter-destination=${failedList}`,
  ...process.argv.slice(2).length ? process.argv.slice(2) : ['tests/*.test.mjs'],
]);
const failed = existsSync(failedList) ? readFileSync(failedList, 'utf8').split('\n').filter(Boolean) : [];
if (status !== 0 && failed.length === 0) process.exit(status ?? 1);

const flaky = [], broken = [];
for (const file of failed) {
  const name = relative(process.cwd(), file);
  console.log(`\nRerunning ${name} alone`);
  (node(['--test-timeout=240000', file]) === 0 ? flaky : broken).push(name);
}

const lines = [];
if (flaky.length) lines.push('### Flaky shared-ui tests', 'Failed in the full run, passed alone:', ...flaky.map(f => `- \`${f}\``));
if (broken.length) lines.push('### Failing shared-ui tests', 'Failed in the full run and again alone:', ...broken.map(f => `- \`${f}\``));
if (lines.length) {
  console.log(`\n${lines.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  for (const f of flaky) console.log(`::warning file=apps/shared-ui/${f}::Flaky: failed in the full run, passed alone`);
}
process.exit(broken.length ? 1 : 0);
