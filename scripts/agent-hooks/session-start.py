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
    for warning in staleness(cwd, branch, git):
        print('WARNING: ' + warning)


def staleness(cwd, branch, git):
    # Refreshing origin/main only moves a remote-tracking ref; offline, the last fetch is used.
    try:
        subprocess.run(['git', '-C', cwd, 'fetch', '--quiet', 'origin', 'main'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
    except (OSError, subprocess.SubprocessError):
        pass
    warnings = []
    top = git('rev-parse', '--show-toplevel').strip()
    if not os.path.exists(os.path.join(top, 'AGENTS.md')):
        warnings.append('this checkout has no AGENTS.md, so it predates the agent guides. '
                        'Update it before working.')
    try:
        behind = int(git('rev-list', '--count', 'HEAD..origin/main').strip())
    except (ValueError, subprocess.SubprocessError):
        return warnings
    if branch == 'main' and behind:
        warnings.append(f'main is {behind} commits behind origin/main. Run git pull --ff-only '
                        'if it is clean, or work in a worktree from origin/main.')
    elif behind > 50:
        warnings.append(f'this branch is {behind} commits behind origin/main. Rebase it, '
                        'or start new work from origin/main.')
    return warnings


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        print('Checkout context unavailable; other agents may share this checkout.')
