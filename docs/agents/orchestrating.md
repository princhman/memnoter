# Orchestrating

For the agent that talks to the user and delegates work. Delegates don't need
this file; they get `AGENTS.md` automatically.

## Ship flow

Unless the user says otherwise, finished work goes through these steps without
being asked each time:

1. Commit only your own changes on the feature branch. If the user asks for
   "everything on the branch", list what you'd include first.
2. Run a sol loop (the `sol-loop` skill), fixing the findings you agree with.
3. `pnpm check:ci`, then open a PR into `main`.
4. Watch CI and fix red checks yourself.
5. Merge when green, if the user approved the feature.
6. Offer release notes. Ask before tagging. A `v*` tag runs `release.yml`:
   desktop installers, TestFlight and the Linear release. memnoter.com follows
   the latest GitHub release by itself.

**Testing sessions.** When the user is testing on devices and says "just fix",
delegates fix only: no tests, no sol loop, no CI waits, no builds while
`pnpm dev:copy` is running. Install on the device only when the user is testing
there. The editor scroll/caret exception in
`apps/shared-ui/AGENTS.md` still applies.

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
  them. Ask the user first.

## Keeping the guides current

- When the user repeats a direction or corrects how agents work, add it to the
  narrowest guide that needs it (`apps/*/AGENTS.md` before the root file, this
  file for orchestration only), in the same change. Memory alone doesn't reach
  delegates.
- Keep the guides short. Remove a rule when it stops being true.
- READMEs describe how to build, run and test, plus a short architecture note.
  Verification logs, screenshot lists and design narration go in the PR
  description, never a README. Tell delegates the same when they touch docs.

## Machines

- **Mac** (the user sits here): Xcode, simulators, the user's devices, the
  installed desktop app.
- **minipc** (Linux): TypeScript, Rust, sync worker. Can't build iOS; its WebKit
  fails a few UI tests even on clean `main`.
- To show minipc work on the Mac: `scripts/preview-on-mac.sh push` on minipc,
  and once, on the Mac, `scripts/preview-on-mac.sh serve <branch>`. Later pushes
  are picked up automatically, with no new Mac thread.

## Data

- Launch branches for the user with `pnpm dev:copy`. If a migration did run on
  the real database, update `/Applications/Memnoter.app` or tell the user.
- Before releasing a new Yjs node, mark or attribute, warn the user and update
  all their devices first. Old builds delete unknown content and it syncs.

## Tools

MCP servers added during a session (Linear, for example) don't load into it.
If an expected tool is missing, tell the user to reconnect it in `/mcp` or start
a new thread.
