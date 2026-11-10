#!/usr/bin/env python3
"""Static accident guard for literal shell commands; never executes input."""
import json
import os
from pathlib import Path
import re
import shlex
import sys

MAIN = Path('/Users/vladyslavnalyvaiko/Projects/notes').resolve()
GIT_MESSAGE = ('Blocked: destructive Git command targets the shared main checkout. '
               'Other agents may own its changes; stash/pop can also leave stale Rust mtimes. '
               'Use git status/diff and commit only your own paths, or use an isolated worktree.')
DEV_MESSAGE = ('Blocked: dev launch without a nonempty MEMNOTER_DATA_DIR can migrate the real '
               'main.db and break the installed app. Use pnpm dev:copy, or explicitly set '
               'MEMNOTER_DATA_DIR to a disposable data directory.')
# Retain the distinction between quoted punctuation (an argument) and shell operators.
TOKEN = re.compile(r'''(?P<space>\s+)|(?P<comment>\#[^\n]*)|(?P<op>&&|\|\||[;&|(){}<>])|(?P<word>(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|(){}<>"'\\])+)''')
ASSIGN = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*=')


def tokens(command):
    command = command.replace('\\\n', '')
    pos = 0
    while pos < len(command):
        match = TOKEN.match(command, pos)
        if not match:
            raise ValueError('unclosed quote or unsupported shell syntax')
        raw = match.group()
        pos = match.end()
        kind = match.lastgroup
        if kind == 'space':
            if '\n' in raw:
                yield ';', True
        elif kind == 'op':
            yield raw, True
        elif kind == 'word':
            yield shlex.split(raw)[0], False


def path_at(value, cwd):
    value = os.path.expanduser(value)
    # Unknown expansions cannot establish that a destructive command is isolated.
    if '$' in value or '`' in value:
        return MAIN
    return (Path(cwd) / value).resolve()


def shared(cwd):
    # Subdirectories of this checkout count too, but nested independent worktrees do not.
    current = Path(cwd).resolve()
    while current != MAIN and current != current.parent:
        if (current / '.git').exists():
            return False
        current = current.parent
    return current == MAIN


def git_command(args, cwd):
    i = 0
    while i < len(args) and args[i].startswith('-'):
        arg = args[i]
        if arg in ('-C', '-c', '--git-dir', '--work-tree', '--config-env'):
            if i + 1 == len(args):
                return
            if arg in ('-C', '--work-tree'):
                cwd = path_at(args[i + 1], cwd)
            i += 2
        elif arg.startswith('-C'):
            cwd = path_at(arg[2:], cwd)
            i += 1
        elif arg.startswith('--work-tree='):
            cwd = path_at(arg.split('=', 1)[1], cwd)
            i += 1
        else:
            i += 1
    if not shared(cwd) or i == len(args):
        return
    cmd, rest = args[i], args[i + 1:]
    flags = rest[:rest.index('--')] if '--' in rest else rest
    short = ''.join(a[1:] for a in flags if a.startswith('-') and not a.startswith('--'))
    blocked = (
        (cmd == 'stash' and (not rest or rest[0] not in ('list', 'show'))) or
        (cmd == 'reset' and any(a.split('=')[0] == '--hard' for a in flags)) or
        (cmd == 'checkout' and ('--' in rest or '.' in rest)) or
        (cmd == 'restore' and (('--staged' not in flags and 'S' not in short) or
                              '--worktree' in flags or 'W' in short)) or
        (cmd == 'clean' and ('--force' in flags or 'f' in short) and
         '--dry-run' not in flags and 'n' not in short)
    )
    if blocked:
        raise PermissionError(GIT_MESSAGE)


def check_simple(args, cwd, env, depth):
    if not args:
        return cwd, env
    local = env.copy()
    while args and ASSIGN.match(args[0]):
        key, value = args.pop(0).split('=', 1)
        local[key] = value
    if not args:
        # Assignment-only shell statements need export before child processes inherit them.
        env.update({k: v for k, v in local.items() if k in env})
        return cwd, env
    exe = Path(args[0]).name
    if exe in ('command', 'exec', 'nohup'):
        check_simple(args[1:], cwd, local, depth)
    if exe == 'env':
        args = args[1:]
        while args and args[0].startswith('-'):
            option = args.pop(0)
            if option in ('-i', '--ignore-environment'):
                local = {}
            elif option in ('-u', '--unset') and args:
                local.pop(args.pop(0), None)
            elif option.startswith('--unset='):
                local.pop(option.split('=', 1)[1], None)
            elif option == '--':
                break
        check_simple(args, cwd, local, depth)
    elif exe in ('bash', 'sh', 'zsh'):
        for i, arg in enumerate(args[1:], 1):
            if arg.startswith('-') and 'c' in arg and i + 1 < len(args):
                check(args[i + 1], cwd, local, depth + 1)
                break
    elif exe == 'cd':
        targets = [a for a in args[1:] if a not in ('--', '-P', '-L')]
        target = path_at(targets[0] if targets else str(Path.home()), cwd)
        if target.is_dir():
            cwd = target
    elif exe == 'export':
        for arg in args[1:]:
            if ASSIGN.match(arg):
                key, value = arg.split('=', 1)
                env[key] = value
    elif exe == 'unset':
        for arg in args[1:]:
            env.pop(arg, None)
    elif exe == 'git':
        git_command(args[1:], cwd)
    elif exe in ('pnpm', 'tauri'):
        rest = args[1:]
        while rest and rest[0].startswith('-'):
            option = rest.pop(0)
            if option in ('--filter', '-F', '-r', '--recursive') or option.startswith('--filter='):
                return cwd, env  # Workspace package dev servers do not run the desktop shell.
            if option in ('-C', '--dir', '--prefix') and rest:
                rest.pop(0)
        if exe == 'pnpm' and rest[:1] == ['run']:
            rest = rest[1:]
        dev = (exe == 'tauri' and rest[:1] == ['dev']) or (exe == 'pnpm' and
              (rest[:1] == ['dev'] or rest[:2] == ['tauri', 'dev'] or
               rest[:3] == ['exec', 'tauri', 'dev']))
        value = local.get('MEMNOTER_DATA_DIR', '')
        value = os.path.expandvars(value)
        if dev and (not value or '$' in value or '`' in value):
            raise PermissionError(DEV_MESSAGE)
    return cwd, env


def check(command, cwd, env, depth=0):
    if depth > 8:
        raise ValueError('shell wrappers nested too deeply')
    stream = list(tokens(command))
    pos = 0

    def at(*values):
        return pos < len(stream) and stream[pos][1] and stream[pos][0] in values

    def unit():
        nonlocal pos
        if at('(', '{'):
            opening = stream[pos][0]
            pos += 1
            node = sequence()
            if not at(')' if opening == '(' else '}'):
                raise ValueError('unclosed shell group')
            pos += 1
            return ('subshell' if opening == '(' else 'group', node)
        args = []
        while pos < len(stream) and not at(';', '&&', '||', '|', '&', ')', '}'):
            args.append(stream[pos][0])
            pos += 1
        return ('command', args)

    def pipeline():
        nonlocal pos
        node = unit()
        while at('|'):
            pos += 1
            node = ('pipe', node, unit())
        return node

    def logical():
        nonlocal pos
        node = pipeline()
        while at('&&', '||'):
            op = stream[pos][0]
            pos += 1
            node = (op, node, pipeline())
        return node

    def sequence():
        nonlocal pos
        node = logical()
        while at(';', '&'):
            op = stream[pos][0]
            pos += 1
            if op == '&':
                node = ('subshell', node)
            node = ('sequence', node, logical())
        return node

    def unique(states):
        result = { (str(c), tuple(sorted(e.items())), ok): (c, e, ok) for c, e, ok in states }
        if len(result) > 128:
            raise ValueError('too many conditional shell paths; split the command')
        return list(result.values())

    def evaluate(node, states):
        kind = node[0]
        if kind == 'command':
            outputs = []
            for c, e, _ in states:
                args = node[1]
                new_c, new_e = check_simple(args.copy(), c, e.copy(), depth)
                outputs.append((new_c, new_e, True))
                # External commands may fail; a later semicolon/OR must retain that path.
                builtin = not args or args[0] in ('export', 'unset', 'true', ':')
                assignments = all(ASSIGN.match(a) for a in args)
                if not builtin and not assignments:
                    outputs.append((c, e, False))
            return unique(outputs)
        if kind in ('subshell', 'group', 'pipe'):
            outputs = []
            for state in states:
                inner = evaluate(node[1], [state])
                if kind == 'group':
                    outputs.extend(inner)
                else:
                    if kind == 'pipe':
                        evaluate(node[2], [state])
                    outputs.extend((state[0], state[1], ok) for _, _, ok in inner)
            return unique(outputs)
        left = evaluate(node[1], states)
        if kind == 'sequence':
            return evaluate(node[2], left)
        run = [s for s in left if s[2] == (kind == '&&')]
        skip = [s for s in left if s[2] != (kind == '&&')]
        return unique(skip + evaluate(node[2], run))

    tree = sequence()
    if pos != len(stream):
        raise ValueError('unexpected shell group terminator')
    evaluate(tree, [(cwd, env, True)])


def main():
    payload = json.load(sys.stdin)
    if payload.get('tool_name', 'Bash') != 'Bash':
        return
    command = payload.get('tool_input', {}).get('command', '')
    check(command, payload.get('cwd', os.getcwd()), dict(os.environ))


if __name__ == '__main__':
    try:
        main()
    except (PermissionError, ValueError, TypeError) as error:
        print(str(error) + ' Rephrase as simple literal commands if parsing failed.', file=sys.stderr)
        sys.exit(2)
