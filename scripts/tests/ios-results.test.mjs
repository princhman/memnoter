import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../ci/check-ios-results.py', import.meta.url));
const phone = 'testReopeningSameNoteAndRelaunchPreserveEdits';
const sync = 'testTwoNativeDatabasesMergeConcurrentYjsEdits';
const navigation = 'testContentsHierarchyFocusAndUnfocusRestoreWholeNote';
const result = (name, status = 'Passed') => ({ nodeType: 'Test Case', name, result: status });

function check(suite, tests) {
  const directory = mkdtempSync(join(tmpdir(), 'memnoter-ios-results-'));
  try {
    const path = join(directory, 'results.json');
    writeFileSync(path, JSON.stringify({ testNodes: [{ nodeType: 'Test Suite', children: tests }] }));
    const run = spawnSync('python3', [guard, suite, path], { encoding: 'utf8' });
    assert.ifError(run.error);
    return run;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('native groups require successful tests, including phone and real sync contracts', () => {
  for (const [suite, tests] of [
    ['phone', [result(phone)]],
    ['drawing', [result('drawing')]],
    ['navigation', [result(sync), result(navigation), result('storage')]],
  ]) {
    const run = check(suite, tests);
    assert.equal(run.status, 0, run.stderr);
  }
});

test('a passing sibling cannot hide a skipped, failed or empty native group', () => {
  for (const tests of [[], [result(sync), result(navigation), result(phone, 'Skipped')],
    [result(sync), result(navigation), result('other', 'Failed')], [result(sync), result(navigation), result('unknown', 'Not Run')]]) {
    const run = check('navigation', tests);
    assert.notEqual(run.status, 0, run.stdout);
  }
});

test('phone and combined navigation groups require their native contracts', async (t) => {
  for (const [suite, tests] of [
    ['phone', [result('unrelated')]],
    ['navigation', [result('unrelated')]],
    ['navigation', [result(sync)]],
    ['navigation', [result(navigation)]],
  ]) {
    await t.test(`${suite}: ${tests.map(test => test.name).join(', ')}`, () => {
      const run = check(suite, tests);
      assert.notEqual(run.status, 0, run.stdout);
    });
  }
});
