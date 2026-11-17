#!/usr/bin/env python3
"""Conservative CI path policy and required-check gates (no third-party modules)."""
import json
import os
import subprocess
import sys

FLAGS = ('frontend', 'rust', 'browser', 'benchmark', 'sync', 'ios')


def selection(event, base):
    selected = set()
    if event not in ('pull_request', 'push', 'workflow_dispatch'):
        raise ValueError(f'unsupported event: {event}')
    if event == 'workflow_dispatch' or not base or set(base) == {'0'}:
        selected.update(FLAGS)
    else:
        # PRs compare against the merge base; pushes compare their exact before SHA.
        # --no-renames includes BOTH sides of a move; NUL preserves unusual names.
        revision = f'{base}...HEAD' if event == 'pull_request' else base
        args = ['git', 'diff', '--no-renames', '--name-only', '-z', revision]
        if event == 'push':
            args.append('HEAD')
        paths = subprocess.check_output(args + ['--']).split(b'\0')
        for raw in filter(None, paths):
            path = os.fsdecode(raw)
            if path.startswith(('docs/', 'scripts/agent-hooks/', '.claude/', '.codex/', '.vscode/')) or path in (
                'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE', '.gitignore',
            ):
                continue
            if path.startswith('apps/shared-ui/tests/'):
                if path.endswith('.test.mjs'):
                    selected.add('browser')
                elif path.endswith('.bench.mjs'):
                    selected.add('benchmark')
                else:
                    selected.update(('browser', 'benchmark'))
            elif path.startswith('apps/shared-ui/'):
                selected.update(('frontend', 'browser', 'benchmark', 'ios'))
            elif path.startswith(('apps/ios/', 'apps/apple-shared/')):
                selected.update(('frontend', 'ios'))
            elif path.startswith('crates/'):
                # Browser command harness and sync integration use the real core.
                selected.update(('frontend', 'rust', 'browser', 'benchmark', 'sync', 'ios'))
            elif path.startswith('apps/sync/'):
                selected.update(('frontend', 'browser', 'sync', 'ios'))
            elif path.startswith('apps/desktop/'):
                selected.update(('frontend', 'rust'))
            elif path.startswith('apps/marketing/'):
                selected.add('frontend')  # Repository-wide style lint.
            else:
                # Root manifests/locks, patches, CI, build scripts and new domains.
                selected.update(FLAGS)
    outputs = {flag: str(flag in selected).lower() for flag in FLAGS}
    outputs['web'] = str(bool(selected & {'browser', 'benchmark'})).lower()
    outputs['web-shards'] = json.dumps(
        (list(range(1, 17)) if 'browser' in selected else [])
        + (['benchmark'] if 'benchmark' in selected else []), separators=(',', ':'))
    return outputs


def gate(kind, needs):
    changes = needs['changes']
    if changes['result'] != 'success':
        raise ValueError('classification did not succeed')
    outputs = changes['outputs']
    for flag in (*FLAGS, 'web'):
        if outputs.get(flag) not in ('true', 'false'):
            raise ValueError(f'missing or invalid selection: {flag}')
    if (outputs['web'] == 'true') != any(outputs[f] == 'true' for f in ('browser', 'benchmark')):
        raise ValueError('inconsistent web selection')
    expected_shards = (list(range(1, 17)) if outputs['browser'] == 'true' else [])
    expected_shards += ['benchmark'] if outputs['benchmark'] == 'true' else []
    if json.loads(outputs['web-shards']) != expected_shards:
        raise ValueError('missing or inconsistent browser matrix')
    if outputs['ios'] == 'true' and outputs['frontend'] != 'true':
        raise ValueError('native coverage requires a same-run frontend build')
    jobs = {'frontend': 'frontend', 'rust': 'rust', 'web': 'web', 'sync': 'sync-server'}
    if kind == 'ios':
        # Frontend is required by this gate only when native coverage is selected.
        jobs = {'ios': 'ios-build'}
        if outputs['ios'] == 'true':
            for job in ('frontend', 'ios-build-started', 'ios-tests'):
                if needs[job]['result'] != 'success':
                    raise ValueError(f'selected job did not succeed: {job}')
    for flag, job in jobs.items():
        if outputs[flag] == 'true' and needs[job]['result'] != 'success':
            raise ValueError(f'selected job did not succeed: {job}')


def main():
    if len(sys.argv) == 4 and sys.argv[1] == 'classify':
        outputs = selection(sys.argv[2], sys.argv[3])
        text = ''.join(f'{key}={value}\n' for key, value in outputs.items())
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as target:
                target.write(text)
        print(text, end='')
    elif len(sys.argv) == 3 and sys.argv[1] == 'gate' and sys.argv[2] in ('check', 'ios'):
        gate(sys.argv[2], json.loads(os.environ['NEEDS']))
    else:
        raise ValueError('usage: select-checks.py classify EVENT BASE | gate check|ios')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f'CI policy failed: {error}')
