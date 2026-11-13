# Orchestrating

For the agent that talks to the user and delegates work. Delegates don't need
this file; they get `AGENTS.md` automatically.

## Ship flow

Unless the user says otherwise, finished work goes through these steps without
being asked each time:

1. Commit only your own changes on the feature branch. If the user asks for
   "everything on the branch", list what you'd include first.
2. Run a sol loop (the `sol-loop` skill), fixing the findings you agree with.
   For a visual change, start it only after the user has approved the
   interface, so a review fix can't change what they approved unseen.
   Changes with no UI/UX effect get their sol loop straight away. You start
   the loop; don't ask delegates on visual work to run one first.
3. Batch: merge the round's ready branches into one
   `batch/<yyyy-mm-dd>-<topic>` branch, `pnpm check:ci` once, and open one PR
   listing `Fixes PRI-<n>` for each issue. Every PR and every merge to main runs
   CI (main runs everything, iOS included), so no PR for a single small fix.
   Keep visual and behaviour-only work in separate batches only if one would
   hold the other up; one preview branch then covers all the visual changes.
4. Watch CI (`watch_pull_request`) and fix red checks yourself; delegates
   don't wait for it. A visual PR needs green CI only at merge time, so
   nothing waits on it before the user approves. A one-off iOS simulator
   failure in code the PR didn't touch: rerun the failed job once.
5. Merge when green, if the user approved the feature. Every ready issue sits
   in Linear **In Review**. A visual PR waits until the user has looked at
   it; a behaviour-only PR merges on green once the sol loop approves.
6. Offer release notes. Ask before tagging. A `v*` tag runs `release.yml`:
   desktop installers, TestFlight and the Linear release. memnoter.com follows
   the latest GitHub release by itself.
7. Clean up without being asked, on the Mac and on minipc: remove merged
   worktrees (`scripts/prune-worktrees.sh --apply`), delete merged local
   branches with `git branch -d`, stop leftover dev servers and test browsers,
   and delete proof files and old temp folders. Keep anything with uncommitted
   or unpushed work, and list it in your report. The orchestrator owns this
   step, including for work its delegates did.

**Testing sessions.** When the user is testing on devices and says "just fix",
delegates fix only: no tests, no sol loop, no CI waits, no builds while
`pnpm dev:copy` is running. Install on the device only when the user is testing
there. The editor scroll/caret exception in
`apps/shared-ui/AGENTS.md` still applies.

## Linear

- When the user reports a bug or request mid-session, file it in Linear before
  or while delegating: team **I build (PRI)**, project **memnoter.com**, label
  **Bug** plus the relevant platform label (for example `windows` or `marketing`).
  Put the issue ID in the delegate brief so it survives chat summaries.
- Branch names follow "Branch names" in `AGENTS.md`: `pri-<n>-<slug>`, never
  Linear's `novvladkyiv/` prefix. Give delegates the exact branch name, and
  pass it as `workspaceStrategy.branch` when launching worktree threads.
- Include `Fixes PRI-<n>` in the PR title or body so GitHub and Linear link the
  work and close the issue through the team's configured merge automation.
- Delegates report the issue ID back with their result.
- Preserve issue IDs or PR numbers in merge/squash commits. For rebase merges,
  keep `Fixes PRI-<n>` in commit messages so release scanning can find the issues.
- Release notes come from the shipped issues in Linear. Enable automatic notes
  and set the notes template in the release pipeline settings; the tag workflow
  syncs the issues without uploading hand-written notes.
- In release notes (GitHub release or Linear), refer to an issue by its number
  alone, for example "(316)". Never write `PRI-316`, and don't add `#`: GitHub
  links `#316` to an unrelated issue or PR.

## Delegating

- Default workhorse: gpt-6.1-sol via `delegate_task`. Delegate mechanical work.
  If a delegate fails a task once, do it yourself; this matters most for hangs,
  freezes and native-only bugs.
- At most **3 heavy delegates** (cargo, `pnpm build`, browser suites, xcodebuild)
  per machine. 9–12 at once pushed the Mac to load 330. Queue the rest or send
  TS/Rust-only work to minipc.
- Release your own device session before handing simulator work to a delegate.
- After a delegate reports, read its final message before telling the user
  anything.

A brief only needs:

1. **Task** and why, quoting the user's complaint where possible.
2. **Done means**: what the user should see, and on which platform. Name one
   platform until the user has approved the feature; porting is a later brief.
3. **Where**: checkout or branch, and whether to commit.
4. **Mode**: normal, or "fix only, don't test, don't wait for CI".
5. Anything that **overrides** `AGENTS.md`.

Don't restate the stack, commands or rules; the delegate already has them.

## Where work lives

- Make requested changes in the checkout the user is looking at. If you need a
  separate worktree, say so up front and bring the result back before calling it
  done. Work that only exists in a side worktree is not done.
- Backlog, bugs and roadmap: Linear. `plan.md` is retired.
- `scripts/prune-worktrees.sh` lists clean, merged worktrees; `--apply` deletes
  them. Run it as part of cleanup (Ship flow step 7); no need to ask.

## Keeping the guides current

- When the user repeats a direction or corrects how agents work, add it to the
  narrowest guide that needs it (`apps/*/AGENTS.md` before the root file, this
  file for orchestration only), in the same change. Memory alone doesn't reach
  delegates.
- Keep the guides short. Remove a rule when it stops being true.
- READMEs describe how to build, run and test, plus a short architecture note.
  Verification logs, screenshot lists and design narration go in the PR
  description, never a README. Tell delegates the same when they touch docs.

## Flows

- **User present** ("just fix", screenshots, testing on a device): the
  `pair-fix` skill.
- **Handoff** (issues to fix alone, with proof at the end): the `handoff` skill.
- **Lag, freezes, slow typing**: the `perf-investigate` skill.

The skills are general; the per-platform details below are what they look up.

Handoff in this repo: Linear team I build (PRI). An agent waiting on the user
comments on the issue and adds the `Needs input` label; it removes the label
when it picks the issue up again. Each issue gets its own branch in the main
checkout; add a worktree only to work issues in parallel, and remove it once the
branch is pushed.

## Platforms: show, prove, profile

| Platform | Show the user | Proof (video or screenshot) | Cost |
| --- | --- | --- | --- |
| Mac desktop | `pnpm dev:copy`; save and it reloads | `screencapture -v -V <secs> out.mov` once T3 Code has Screen Recording permission | cheap |
| Windows | no Windows machine; Chromium stands in | `PROOF_DIR=<dir>` on a shared-ui test (below) | cheap |
| iPad / iPhone simulator | build for the simulator (below) | `agent-device record start --scope device <file>.mp4`, then `record stop` | expensive (iOS build) |
| User's iPad / iPhone | `scripts/ios-install.sh [--iphone\|--all]` | only the user can record | expensive |

- **Cheap** checks: do them yourself. **Expensive** ones on platforms the issue
  didn't name: ask first.
- **Chromium/WebKit proof:** `PROOF_DIR=<dir>` makes every page a shared-ui test
  opens record a `.webm` into `<dir>`. Write a throwaway test for the scenario if
  no existing one shows it, run it from `apps/shared-ui` with the usual
  `node … --test`, and delete it afterwards. These pages use test data, so they
  prove the shared-ui layout and behaviour, not the native shell.
- **Simulator build:** `xcodebuild -project apps/ios/Memnoter.xcodeproj -scheme
  Memnoter -destination id=<udid> -derivedDataPath apps/ios/build build`, then
  `agent-device install com.vladyslavnalyvaiko.memnoter.ipad
  apps/ios/build/Build/Products/Debug-iphonesimulator/Memnoter.app`. UDIDs are
  in `apps/ios/README.md`. The recorder only writes frames when the screen
  changes, so drive the scenario while recording.
- **minipc** can make Chromium/WebKit proof only (no iOS, no macOS).
- **Uploads:** proof goes on the Linear issue, one file at a time
  (`prepare_file_upload`, then PUT within 60 s). Delete every local video and
  screenshot after it's uploaded; none go in the repo or stay on the machine.

**Profiling** (verified on the Mac 2026-11-11 unless marked):

- **Mac desktop:** measure a production frontend, never `pnpm dev`:
  `pnpm tauri build --debug --no-bundle` run with `MEMNOTER_DATA_DIR` pointing
  at a `pnpm dev:copy` copy. Then `sample <pid> 5 -file out.txt` on `memnoter`
  and on its `com.apple.WebKit.WebContent` process (the one started right after
  it; `ps -A -o pid,lstart,comm`), or `xcrun xctrace record --template 'Time
  Profiler' --attach <pid> --time-limit 10s --output out.trace`. Headless tests
  miss macOS text-input paths (the Cmd+A Writing Tools freeze).
- **iPad / iPhone:** simulators run on the Mac's CPU, so their timings mean
  nothing. On a device: `xcrun xctrace record --template 'Time Profiler'
  --device <udid> --attach Memnoter` (unverified: the devices were offline).
  Editor JS timings need Safari's Web Inspector on the device, which only the
  user can open.
- **shared-ui in isolation:** `tests/copy-large-note.bench.mjs` and
  `tests/large-note.bench.mjs` (`COPY_PROFILE=1` for a Chromium CPU profile).

## Machines

- **Mac** (the user sits here): Xcode, simulators, the user's devices, the
  installed desktop app.
- **minipc** (Linux): TypeScript, Rust, sync worker. Can't build iOS; its WebKit
  fails a few UI tests even on clean `main`.
- To show minipc work on the Mac: `scripts/preview-on-mac.sh push` on minipc,
  and once, on the Mac, `scripts/preview-on-mac.sh serve <branch>`. Later pushes
  are picked up automatically, with no new Mac thread.

## Data

- Claude Code and Codex safety hooks: see `scripts/agent-hooks/README.md` (Codex hooks require trust review).

- Launch branches for the user with `pnpm dev:copy`. If a migration did run on
  the real database, update `/Applications/Memnoter.app` or tell the user.
- Before releasing a new Yjs node, mark or attribute, warn the user and update
  all their devices first. Old builds delete unknown content and it syncs.

## Tools

MCP servers added during a session (Linear, for example) don't load into it.
If an expected tool is missing, tell the user to reconnect it in `/mcp` or start
a new thread.
