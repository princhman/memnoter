"""Exercise CI's actual CLI with real commit graphs and aggregate job results."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

POLICY = Path(__file__).resolve().parents[1] / 'ci/select-checks.py'
FULL = {'frontend', 'rust', 'browser', 'benchmark', 'sync', 'ios'}


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'ci@example.test')
        self.git('config', 'user.name', 'CI test')
        self.git('commit', '-qm', 'initial', '--allow-empty')
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, text=True,
                              capture_output=True, check=True)

    def commit(self, path):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('fixture\n')
        self.git('add', '--', path)
        self.git('commit', '-qm', 'change')

    def classify(self, event='push', base=None, ok=True):
        result = subprocess.run(['python3', str(POLICY), 'classify', event,
                                 self.base if base is None else base],
                                cwd=self.repo, text=True, capture_output=True,
                                env={k: v for k, v in os.environ.items() if k != 'GITHUB_OUTPUT'})
        if not ok:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(result.stdout, '')  # Never publish partial selections.
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = dict(line.split('=', 1) for line in result.stdout.splitlines())
        self.assertTrue(all(outputs[f] in ('true', 'false') for f in FULL | {'web'}))
        selected = {f for f in FULL if outputs[f] == 'true'}
        shards = json.loads(outputs['web-shards'])
        expected = (list(range(1, 17)) if 'browser' in selected else [])
        expected += ['benchmark'] if 'benchmark' in selected else []
        self.assertEqual(shards, expected)
        self.assertEqual(outputs['web'], str(bool(shards)).lower())
        return selected

    def test_domains_on_both_event_diffs(self):
        cases = {
            'docs/guide.md': set(), 'AGENTS.md': set(),
            '.codex/config.toml': set(), 'scripts/agent-hooks/run.sh': set(),
            'apps/marketing/src/page.ts': {'frontend'},
            'apps/desktop/src/lib.rs': {'frontend', 'rust'},
            'apps/ios/Sources/Screen.swift': {'frontend', 'ios'},
            'apps/apple-shared/DrawingDocument.swift': {'frontend', 'ios'},
            'apps/shared-ui/src/components/Editor.tsx': {'frontend', 'browser', 'benchmark', 'ios'},
            'apps/shared-ui/public/help.md': {'frontend', 'browser', 'benchmark', 'ios'},
            'apps/shared-ui/vite.config.ts': {'frontend', 'browser', 'benchmark', 'ios'},
            'apps/shared-ui/tests/editor.test.mjs': {'browser'},
            'apps/shared-ui/tests/copy-large-note.bench.mjs': {'benchmark'},
            'apps/shared-ui/tests/support/fixture.html': {'browser', 'benchmark'},
            'apps/sync/test/fixtures/protocol.json': {'frontend', 'browser', 'sync', 'ios'},
            'crates/memnoter-ffi/src/lib.rs': FULL,
            'patches/history.patch': FULL, 'pnpm-lock.yaml': FULL,
            'package.json': FULL, 'Cargo.toml': FULL,
            '.github/workflows/ci.yml': FULL, 'scripts/check-ci.sh': FULL,
            'scripts/ci/select-checks.py': FULL, 'unclassified/file.md': FULL,
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.base = self.git('rev-parse', 'HEAD').stdout.strip()
                self.commit(path)
                for event in ('push', 'pull_request'):
                    self.assertEqual(self.classify(event), expected)

    def test_delete_rename_and_newline_paths_preserve_both_domains(self):
        self.commit('apps/shared-ui/public/content\nfile.md')
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()
        # Move bundled content into docs: the deleted production path still counts.
        (self.repo / 'docs').mkdir()
        self.git('mv', 'apps/shared-ui/public/content\nfile.md', 'docs/moved.md')
        self.git('commit', '-qm', 'move')
        self.assertEqual(self.classify(), {'frontend', 'browser', 'benchmark', 'ios'})
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('rm', 'docs/moved.md')
        self.git('commit', '-qm', 'delete docs')
        self.assertEqual(self.classify(), set())
        self.commit('apps/ios/Tests/Native.swift')
        self.base = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('rm', 'apps/ios/Tests/Native.swift')
        self.git('commit', '-qm', 'delete native test')
        self.assertEqual(self.classify(), {'frontend', 'ios'})

    def test_pr_merge_base_and_push_before_are_distinct(self):
        self.git('branch', 'feature')
        self.commit('package.json')
        main_tip = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('switch', '-q', 'feature')
        self.commit('docs/guide.md')
        self.assertEqual(self.classify('pull_request', main_tip), set())
        self.assertEqual(self.classify('push', main_tip), FULL)

    def test_full_escape_hatches_and_invalid_git_fail_closed(self):
        self.commit('docs/guide.md')
        for event, base in [('workflow_dispatch', 'bad-base'), ('push', ''),
                            ('push', '0' * 40), ('pull_request', '')]:
            self.assertEqual(self.classify(event, base), FULL)
        for base in ('bad-base', 'f' * 40):
            self.classify(base=base, ok=False)
        # Valid base but failed git diff (HEAD is no longer resolvable).
        self.git('symbolic-ref', 'HEAD', 'refs/heads/unborn')
        self.classify(ok=False)


class GateTests(unittest.TestCase):
    def gate(self, selected, kind, bad_job=None, state='success', missing=None, override=None):
        outputs = {flag: str(flag in selected).lower() for flag in FULL}
        outputs['web'] = str(bool(selected & {'browser', 'benchmark'})).lower()
        outputs['web-shards'] = json.dumps(
            (list(range(1, 17)) if 'browser' in selected else [])
            + (['benchmark'] if 'benchmark' in selected else []))
        if missing:
            outputs.pop(missing)
        outputs.update(override or {})
        needs = {'changes': {'result': 'success', 'outputs': outputs}}
        for job in ('frontend', 'rust', 'web', 'sync-server', 'ios-build', 'ios-build-started', 'ios-tests'):
            needs[job] = {'result': 'success' if selected else 'skipped'}
        if bad_job:
            needs[bad_job]['result'] = state
        return subprocess.run(['python3', str(POLICY), 'gate', kind], capture_output=True,
                              text=True, env={**os.environ, 'NEEDS': json.dumps(needs)})

    def test_selected_jobs_require_success_and_unselected_jobs_can_skip(self):
        for kind, jobs in [('check', ('frontend', 'rust', 'web', 'sync-server')),
                           ('ios', ('frontend', 'ios-build', 'ios-build-started', 'ios-tests'))]:
            self.assertEqual(self.gate(FULL, kind).returncode, 0)
            self.assertEqual(self.gate(set(), kind).returncode, 0)
            for job in (*jobs, 'changes'):
                for state in ('failure', 'cancelled', 'skipped'):
                    with self.subTest(kind=kind, job=job, state=state):
                        result = self.gate(FULL, kind, job, state)
                        self.assertNotEqual(result.returncode, 0, result.stdout)
            for flag in FULL | {'web', 'web-shards'}:
                self.assertNotEqual(self.gate(set(), kind, missing=flag).returncode, 0)
            self.assertNotEqual(self.gate({'ios'}, kind).returncode, 0)
            for override in ({'ios': 'TRUE'}, {'web': 'false'},
                             {'web-shards': '[1]'}, {'web-shards': 'broken'}):
                self.assertNotEqual(self.gate(FULL, kind, override=override).returncode, 0)
        # Browser-only and native-only changes must not require unrelated jobs.
        self.assertEqual(self.gate({'browser'}, 'check', 'rust', 'skipped').returncode, 0)
        self.assertEqual(self.gate({'frontend', 'ios'}, 'ios', 'web', 'skipped').returncode, 0)


if __name__ == '__main__':
    unittest.main()
