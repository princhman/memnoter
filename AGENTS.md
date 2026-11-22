# Agent guide

Memnoter: a local-first notes app with spaced-repetition flashcards. This file
is what every agent needs. Folder-specific rules live in `apps/shared-ui/AGENTS.md`
and `apps/ios/AGENTS.md`. Before building or changing UI, read `DESIGN.md`.
If you coordinate other agents or talk to the user
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
| `pnpm check:ci` | What CI runs, except the iOS build on Linux (minipc). Run before a PR; `--quick` skips the iOS build. |
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
iPhone, plus any other target the brief names. If a platform deliberately
lacks the feature, say so and get the user's agreement before calling it done.
If the brief doesn't name a platform, ask which one to start on.

Every report names which platforms a shared change reaches (a phone fix in
shared-ui also changes iPad and desktop) and which one you actually checked.

## Issues and decisions

The Linear issue description is the spec. Its sections are **Done means** (one
concrete scenario), **First platform**, **Evidence required** and **Decisions**.

- Read the description before starting. If it has no "Done means", ask on the
  issue (see the `agentline-linear` skill) instead of guessing the outcome.
- When the user answers a question or approves a behaviour, append it to
  **Decisions** with `issue_update`, dated and in their words, in the same turn
  you act on it. A comment or chat message alone gets lost.
- Product and UI behaviour belongs in the issue, never in an `AGENTS.md`.
  The guides hold how to work, not what a feature does.
- Create issues only when the user asks; use the same sections.

## Evidence

Every handback and PR says which level it reached, and on which platform:

| Level | Means |
| --- | --- |
| L1 | Tests, checks or a browser run of shared-ui. |
| L2 | A recording or screenshot of the real app on the named platform (see "Demo recordings"). On a device or simulator, include the build stamp from Settings → About. |
| L3 | Working live across devices (sync, or one device's edit shown on another). |

"Built", "installed", "launched", "registered" and "green CI" are not levels.
Say what you saw, not what you ran. If the issue asks for a level you couldn't
reach, say so and why.

## Shared checkout

Other agents often have uncommitted work in the same checkout.

- The session-start hook warns when the checkout is behind `origin/main`. Don't
  build, demo or branch from a stale checkout: update a clean `main` with
  `git pull --ff-only`, or work in a worktree from `origin/main`.
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

- Never use computer use (an agent driving the Mac's mouse and keyboard) unless
  the user explicitly allows it for that task: they are working on that screen.
  Passive recording with `screencapture` is not computer use and is fine.
- Record the app itself, the way the user sees it: the desktop app on the Mac
  (`pnpm dev:copy`), the app in the simulator, or on minipc the app's own entry
  page served by Vite with `installTestBridge`. Never record a test fixture, a
  bare editor page, or a wrapper page built for the demo.
- Pace it for a person watching once: type at a readable speed (no instant
  fills), pause about a second after each step so its result is visible, and
  cut idle time. Keep each scenario under about 30 seconds. Use a normal window
  size and zoom, so text is readable.
- Watch it back once at normal speed before posting. Each pickup, drop target
  and result must be readable; re-record anything that goes by too fast.

## Data safety

- `pnpm dev` and release builds open the user's real database. A migration run
  there stops the installed app from starting. Use `pnpm dev:copy`.
- Older builds delete Yjs nodes, marks and attributes they don't know, and the
  deletion syncs. If you add one, say so in your report.
- `apps/sync` and `apps/marketing` deploy from `main` through the Cloudflare
  dashboard. Never deploy them by hand or add a deploy workflow;
  `pnpm lint` rejects both.
- `apps/sync` goes live on merge, before any app update reaches users. It must
  keep working with the latest released app: only add endpoints and optional
  fields. A protocol change raises `version` in
  `apps/sync/test/fixtures/protocol.json` but leaves `oldestVersion`, so the
  server still accepts the released app; raise `oldestVersion` only after a
  release with the new version has shipped.

## Tests

- Add a regression test for a real bug (editor, sync, data loss), preferably in
  an existing file. No tests for one-off visual tweaks.
- Browser suites are timing-sensitive. Rerun a failure alone before blaming your
  change, and say which you did.
- A flaky test gets fixed or merged into a reliable one. Skip it on CI only
  when the user says so, only that case, and keep it runnable locally.
- "Verified" means you performed the reported action through the app's real
  entry point (a real pointer drag for a drag bug). A launch or a synthetic
  event doesn't count; say which you did.
- A fix changes only the reported defect. Ask before changing how anything
  next to it looks or behaves, unless you are certain the user would accept it.
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
End with: commit SHA (or "uncommitted"), the evidence level reached and on
which platform, what you verified, what you didn't.
Never end on any other pending wait; finish waiting first.
