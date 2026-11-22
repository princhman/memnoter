# Agent hooks
Requires Python 3 and Git. The configs are tracked, so every checkout gets them:
`.claude/settings.json` (Claude Code) and `.codex/hooks.json` (Codex CLI 0.167.0+,
after project and hook trust review in `/hooks`). Other files in `.claude/` and
`.codex/` stay local.
Both use the same stdin JSON scripts; denial exits 2 with a safe alternative on stderr.
A command the parser can't follow (a heredoc, for example) runs with a warning on stderr.
Git guards apply to this repository's primary checkout (including subdirectories), found
through `git rev-parse --git-common-dir`; `MEMNOTER_MAIN_CHECKOUT` overrides it.
Isolated worktrees may use destructive Git commands; dev launches always need a data override.
Use `pnpm dev:copy` to launch against disposable data.
The parser handles literal commands, quotes, chains, `cd`, `git -C`, env prefixes and shell `-c`.
This is an accident guard, not a shell sandbox: aliases, scripts, dynamic expansion,
command substitution, heredocs and arbitrary shell control flow are not fully interpreted.
SessionStart reports branch, dirty files and worktree count. It refreshes `origin/main`
(a remote-tracking ref only) and warns when `main` is behind it, a branch is more than 50
commits behind, or the checkout has no `AGENTS.md`.
Run payload checks: `python3 scripts/agent-hooks/test_hooks.py`.
Schemas: [Claude](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks).
