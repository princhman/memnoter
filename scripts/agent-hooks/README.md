# Agent hooks
Requires Python 3 and Git. Claude Code loads `.claude/settings.json`;
Codex CLI 0.167.0+ loads `.codex/hooks.json` after project and hook trust review (`/hooks`).
Both use the same stdin JSON scripts; denial exits 2 with a safe alternative on stderr.
Git guards apply only to `/Users/vladyslavnalyvaiko/Projects/notes` (including subdirectories).
Isolated worktrees may use destructive Git commands; dev launches always need a data override.
Use `pnpm dev:copy` to launch against disposable data.
The parser handles literal commands, quotes, chains, `cd`, `git -C`, env prefixes and shell `-c`.
This is an accident guard, not a shell sandbox: aliases, scripts, dynamic expansion,
command substitution, heredocs and arbitrary shell control flow are not fully interpreted.
SessionStart reports branch, dirty files and worktree count without changing files.
Run payload checks: `python3 scripts/agent-hooks/test_hooks.py`.
Schemas: [Claude](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks).
