#!/usr/bin/env python3
"""Read-only checkout context for Claude Code and Codex."""
import json
import os
import subprocess
import sys


def main():
    payload = json.load(sys.stdin)
    cwd = payload.get('cwd', os.getcwd())

    def git(*args):
        return subprocess.check_output(['git', '-C', cwd, *args], stderr=subprocess.DEVNULL,
                                       timeout=5).decode(errors='replace')

    branch = git('branch', '--show-current').strip() or '(detached HEAD)'
    records = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
    paths = []
    i = 0
    while i < len(records) and records[i]:
        record = records[i]
        paths.append(record[3:])
        i += 2 if 'R' in record[:2] or 'C' in record[:2] else 1
    others = max(0, git('worktree', 'list', '--porcelain').count('worktree ') - 1)
    print('Agent checkout context')
    print('Branch: ' + branch)
    print(f'Uncommitted files: {len(paths)}')
    for path in paths[:4]:
        print('  ' + json.dumps(path, ensure_ascii=False))
    print(f'Other worktrees: {others}')
    print('Other agents may share this checkout; preserve their uncommitted work.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        print('Checkout context unavailable; other agents may share this checkout.')
