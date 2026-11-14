# Agent guide

Memnoter: a local-first notes app with spaced-repetition flashcards. This file
is what every agent needs. Folder-specific rules live in `apps/shared-ui/AGENTS.md`
and `apps/ios/AGENTS.md`. If you coordinate other agents or talk to the user
directly (not as a delegate), also read `docs/agents/orchestrating.md`.
When you use the `pair-fix`, `handoff` or `perf-investigate` skill, read the
Flows and Platforms sections of that file: they hold this repo's tracker, proof
and profiling details.

## Layout

| Path | What |
| --- | --- |
| `apps/shared-ui` | React + TipTap editor and app UI, shared by desktop, iPad and iPhone. |
| `apps/desktop` | Tauri shell (macOS, Windows). |
| `apps/ios` | SwiftUI app for iPhone and iPad; embeds the shared-ui editor in a WKWebView. |
| `crates/memnoter-core` | Rust core: database, cards, sync engine, import. `memnoter-ffi` = UniFFI for iOS. |
| `apps/sync` | Cloudflare Worker sync server. |
| `apps/marketing` | memnoter.com. |

## Commands

| Command | Use |
| --- | --- |
| `pnpm check:ci` | Everything CI runs. Run before a PR; `--quick` skips the iOS build. |
| `pnpm test` | shared-ui tests. One file: `node --experimental-strip-types --import ./tests/support/register.mjs --test tests/<name>.test.mjs` in `apps/shared-ui`. |
| `cargo test -p memnoter-core` | Core tests. |
| `pnpm dev:device` | LAN shared-ui server for `scripts/ios-install.sh --live` Debug installs. |
| `pnpm dev:copy` | Desktop app on a copy of the user's notes. Use this, not `pnpm dev`, to run a branch. |

Prefix cargo commands with `CARGO_BUILD_JOBS=4`; other agents share the machine.
On the Mac, cargo goes through sccache, so a fresh worktree reuses compiled
dependencies. Don't set `CARGO_TARGET_DIR`; it changes the cache key.
Never run a dev server in the foreground of a tool call.

## Seeing a change

- **Desktop with `pnpm dev:copy` running:** save and let it reload. Vite
  hot-reloads shared-ui, and Tauri rebuilds Rust changes by itself. Don't run
  `pnpm build`, `cargo build` or `tsc` just to show the user a change.
- **On a device:** run `scripts/ios-install.sh` (add `--core` after `crates/`
  changes). That build is needed every time, so batch fixes before installing.
- **Before a PR:** `pnpm check:ci`. That is where the full build belongs.

## One platform first

Build and check a feature on the one platform the user is testing. Don't port
it to, or polish it for, the other platforms until the user says it's right.
Then port it and check every platform: Mac, Windows (Chromium), iPad and
iPhone. If the brief doesn't name a platform, ask which one to start on.

## Shared checkout

Other agents often have uncommitted work in the same checkout.

- Commit only your own changes. Never stage, stash, reset or revert anyone else's.
- No `git stash` / `reset` / `checkout --` here. If it happened anyway, `touch`
  changed Rust sources before rebuilding: cargo uses mtimes and reuses stale builds.
- Don't add plans or notes to the repo; the backlog is in Linear.
- Read and write Linear only through the `agentline` tools (see the
  `agentline-linear` skill). Never post as the user.

## Branch names

- Issue work: `pri-<n>-<slug>`, lowercase, no user prefix. Take the issue's
  `gitBranchName` from Linear and drop everything up to the first `/`: with
  `b=novvladkyiv/pri-366-remove-double-space-in-code-block-for`,
  `git switch -c "${b#*/}" origin/main` gives
  `pri-366-remove-double-space-in-code-block-for`.
- Batch PRs (several issues, opened by the orchestrator):
  `batch/<yyyy-mm-dd>-<topic>`.
- Work without an issue: `<type>/<slug>` (`fix/`, `feat/`, `chore/`, `docs/`,
  `release/v<x.y.z>`).
- A worktree tool or brief that hands you a branch with another prefix
  (`novvladkyiv/…`, `codex/…`, `t3-…`): rename it with `git branch -m` before
  your first push. Renaming a branch on GitHub closes its open PR.

## Demo recordings

- Record the app itself, the way the user sees it: the desktop app on the Mac
  (`pnpm dev:copy`), the app in the simulator, or on minipc the app's own entry
  page served by Vite with `installTestBridge`. Never record a test fixture, a
  bare editor page, or a wrapper page built for the demo.
- Pace it for a person watching once: type at a readable speed (no instant
  fills), pause about a second after each step so its result is visible, and
  cut idle time. Keep each scenario under about 30 seconds. Use a normal window
  size and zoom, so text is readable.

## Data safety

- `pnpm dev` and release builds open the user's real database. A migration run
  there stops the installed app from starting. Use `pnpm dev:copy`.
- Older builds delete Yjs nodes, marks and attributes they don't know, and the
  deletion syncs. If you add one, say so in your report.

## Tests

- Add a regression test for a real bug (editor, sync, data loss), preferably in
  an existing file. No tests for one-off visual tweaks.
- Browser suites are timing-sensitive. Rerun a failure alone before blaming your
  change, and say which you did.
- If the brief says "fix only, don't test", make the change visible (see
  "Seeing a change") and stop.

## Report

Push your branch but don't open a PR unless the brief says so: the
orchestrator groups branches into one batch PR, because every PR and every
merge to main runs the full CI. Put `Fixes PRI-<n>` in your commit message; for
an issue you didn't fix (not reproduced, waiting on the user), write
`Refs PRI-<n>` so merging doesn't close it.
Once the branch is pushed and its proof is on the issue, move the issue to
**In Review** in Linear, whether the fix is visual or behaviour-only.
Don't wait for GitHub CI: push, report, and stop.
End with: commit SHA (or "uncommitted"), what you verified, what you didn't.
Never end on any other pending wait; finish waiting first.
