"""Exercise the stdin/exit-code contract without executing guarded commands."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
# A stand-in for the primary checkout; the hook reads it from MEMNOTER_MAIN_CHECKOUT.
_MAIN_DIR = tempfile.TemporaryDirectory()
MAIN = str(Path(_MAIN_DIR.name).resolve())
subprocess.run(['git', 'init', MAIN], capture_output=True, check=True)
(Path(MAIN) / 'crates').mkdir()


class Hooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.isolated = cls.directory.name
        subprocess.run(['git', 'init', cls.isolated], capture_output=True, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def invoke(self, script, payload):
        env = dict(os.environ)
        env.pop('MEMNOTER_DATA_DIR', None)
        env['MEMNOTER_MAIN_CHECKOUT'] = MAIN
        return subprocess.run([sys.executable, str(HERE / script)], input=json.dumps(payload),
                              text=True, capture_output=True, env=env, check=False)

    def test_command_policy(self):
        # These cases cover the incident boundary: the hook must decide before Bash runs.
        blocked = [
            'git stash', 'git stash push -u', 'git stash pop', 'git stash apply',
            'git stash drop', 'git stash clear', 'git reset --hard HEAD',
            'git checkout -- crates/core.rs', 'git checkout .', 'git restore file',
            'git restore --source=HEAD .', 'git restore --staged --worktree .',
            'git clean -fd', 'git clean --force',
            'git status && git stash', 'git diff; git reset --hard',
            'git status\ngit clean -f', f'cd {MAIN}/crates && git restore .',
            'git \\\nstash pop',
            f'git -C {MAIN} stash pop', f'git -C / -C {MAIN[1:]} stash',
            f'git --no-pager -c color.ui=false -C{MAIN} reset --hard',
            f'cd {self.isolated} || git stash pop',
            'cd /nonexistent-memnoter-hook-directory; git stash pop',
            "bash -lc 'git stash pop'", 'command git clean -ffdx',
            'pnpm dev', 'pnpm tauri dev', 'tauri dev', 'pnpm run dev',
            'pnpm exec tauri dev', 'git status && pnpm dev',
            'pnpm --dir . dev', 'pnpm -C apps/desktop tauri dev', 'tauri --verbose dev',
            'MEMNOTER_DATA_DIR= pnpm dev', 'env MEMNOTER_DATA_DIR= tauri dev',
            'MEMNOTER_DATA_DIR=/tmp/copy echo ok; pnpm dev',
            'MEMNOTER_DATA_DIR=/tmp/copy command echo ok; pnpm dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy; unset MEMNOTER_DATA_DIR; pnpm dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy; env -u MEMNOTER_DATA_DIR pnpm dev',
            '(export MEMNOTER_DATA_DIR=/tmp/copy); pnpm dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy | cat; pnpm dev',
            'git status && export MEMNOTER_DATA_DIR=/tmp/copy; pnpm dev',
            f'git status && cd {self.isolated}; git stash pop',
        ]
        allowed = [
            'git status', 'git diff -- file', 'git log -5', 'git stash list',
            'git stash show -p', 'git reset --soft HEAD~1', 'git reset HEAD file',
            'git checkout feature', 'git restore --staged file', 'git restore -S file',
            'git clean -nd', 'git clean -fdn', 'git diff --hard',
            'echo "git stash pop; pnpm dev"', "printf '%s' '&&' 'git stash'",
            'git status # git stash pop', 'pnpm dev:copy', 'pnpm dev:ui',
            'pnpm --filter memnoter-shared-ui dev',
            'pnpm --filter=memnoter-shared-ui dev',
            'MEMNOTER_DATA_DIR=/tmp/copy pnpm dev',
            'MEMNOTER_DATA_DIR="/tmp/notes copy" pnpm tauri dev',
            'MEMNOTER_DATA_DIR="$HOME/notes-copy" pnpm dev',
            'env MEMNOTER_DATA_DIR=/tmp/copy tauri dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy; pnpm dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy && pnpm dev',
            'export MEMNOTER_DATA_DIR=/tmp/copy || pnpm dev',
            'MEMNOTER_DATA_DIR=/tmp/copy bash -c "pnpm dev"',
            f'cd {self.isolated} && git stash pop', f'git -C {self.isolated} reset --hard',
        ]
        for command in blocked + allowed:
            with self.subTest(command=command):
                result = self.invoke('pre-tool-use.py', {
                    'cwd': MAIN, 'tool_name': 'Bash', 'tool_input': {'command': command}})
                self.assertEqual(result.returncode, 2 if command in blocked else 0, result.stderr)
                if command in blocked:
                    self.assertIn('Blocked:', result.stderr)
                    self.assertRegex(result.stderr, 'isolated worktree|pnpm dev:copy')
        print(f'Policy payloads checked: {len(blocked)} blocked, {len(allowed)} allowed')

    def test_registered_commands(self):
        root = HERE.parents[1]
        for config in ['.claude/settings.json', '.codex/hooks.json']:
            hooks = json.loads((root / config).read_text())['hooks']
            self.assertEqual(hooks['PreToolUse'][0]['matcher'], 'Bash')
            for event, command, expected in [('PreToolUse', 'pnpm dev', 2),
                                             ('PreToolUse', 'git status', 0),
                                             ('SessionStart', '', 0)]:
                with self.subTest(config=config, event=event, command=command):
                    registered = hooks[event][0]['hooks'][0]['command']
                    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(root))
                    env.pop('MEMNOTER_DATA_DIR', None)
                    result = subprocess.run(registered, shell=True, cwd=HERE, env=env,
                                            input=json.dumps({'cwd': str(root), 'tool_name': 'Bash',
                                                              'tool_input': {'command': command}}),
                                            text=True, capture_output=True, check=False)
                    self.assertEqual(result.returncode, expected, result.stderr)

    def test_worktree_and_data_scope(self):
        for command, expected in [('git stash pop', 0), ('git clean -fd', 0),
                                  ('git checkout .', 0), ('git restore .', 0),
                                  ('pnpm dev', 2), (f'cd {MAIN} && git stash pop', 2),
                                  (f'git -C {MAIN} reset --hard', 2)]:
            with self.subTest(command=command):
                result = self.invoke('pre-tool-use.py', {
                    'cwd': self.isolated, 'tool_name': 'Bash', 'tool_input': {'command': command}})
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_session_context(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args):
                return subprocess.run(['git', '-C', folder, *args], check=True,
                                      capture_output=True, text=True)
            git('init', '-b', 'hook-context')
            (Path(folder) / 'AGENTS.md').write_text('guide')
            git('add', 'AGENTS.md')
            git('-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.test',
                'commit', '-m', 'fixture')
            other = str(Path(folder) / 'other')
            git('worktree', 'add', '-b', 'other', other)
            for name in ['one', 'two', 'three', 'four', 'five', 'with\nnewline']:
                (Path(folder) / name).write_text('untracked')
            result = self.invoke('session-start.py', {'cwd': folder, 'source': 'startup'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Branch: hook-context', result.stdout)
            self.assertIn('Uncommitted files: 7', result.stdout)  # includes other worktree directory
            self.assertIn('Other worktrees: 1', result.stdout)
            self.assertIn('Other agents may share', result.stdout)
            self.assertLessEqual(len(result.stdout.splitlines()), 9)
            print(result.stdout, end='')

    def test_stale_main_warning(self):
        with tempfile.TemporaryDirectory() as folder:
            upstream, clone = str(Path(folder) / 'upstream'), str(Path(folder) / 'clone')

            def git(cwd, *args):
                return subprocess.run(['git', '-C', cwd, '-c', 'user.name=Hook Test',
                                       '-c', 'user.email=hook@example.test', *args],
                                      check=True, capture_output=True, text=True)
            subprocess.run(['git', 'init', '-b', 'main', upstream], check=True, capture_output=True)
            (Path(upstream) / 'AGENTS.md').write_text('guide')
            git(upstream, 'add', 'AGENTS.md')
            git(upstream, 'commit', '-m', 'one')
            subprocess.run(['git', 'clone', '-q', upstream, clone], check=True, capture_output=True)
            git(upstream, 'commit', '--allow-empty', '-m', 'two')
            result = self.invoke('session-start.py', {'cwd': clone, 'source': 'startup'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('WARNING: main is 1 commits behind origin/main', result.stdout)
            git(clone, 'pull', '-q', '--ff-only')
            result = self.invoke('session-start.py', {'cwd': clone, 'source': 'startup'})
            self.assertNotIn('WARNING', result.stdout)


if __name__ == '__main__':
    unittest.main()
