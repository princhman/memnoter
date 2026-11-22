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
   listing `Fixes PRI-<n>` for each issue it finishes (`Refs` for the rest), plus
   the `Acceptance:` and `Evidence:` lines from the PR template. Every PR and every merge to main runs
   CI (main runs everything, iOS included), so no PR for a single small fix.
   Keep visual and behaviour-only work in separate batches only if one would
   hold the other up; one preview branch then covers all the visual changes.
   Risk score for Linear Reviews: add to the sol brief "Also reply
   `RISK: <1-4> <one-line reason>` for the whole diff". Post it on the PR as
   `<!-- linear:extension {"version":1,"plugins":[{"plugin":"riskScore","sha":"<full head SHA>","level":<n>,"explanations":["<reason>"]}]} -->`,
   and again after any new push. Don't read the diff yourself for this.
4. Watch CI (`watch_pull_request`) and fix red checks yourself; delegates
   don't wait for it. A visual PR needs green CI only at merge time, so
   nothing waits on it before the user approves. A one-off iOS simulator
   failure in code the PR didn't touch: rerun the failed job once.
5. Merge when green, if the user approved the feature. Every ready issue sits
   in Linear **In Review**. A visual PR waits until the user has looked at
   it; a behaviour-only PR merges on green once the sol loop approves. When
   the user waives CI for named PRs ("merge, do not wait for ci"), merge those
   once the rest is satisfied and report the CI state.
   CI timing claims come from real run timestamps (`gh run view`), never
   estimates: report the whole run against the user's target.
6. Offer release notes. Ask before tagging. A `v*` tag runs `release.yml`:
   desktop installers, TestFlight and the Linear release. memnoter.com follows
   the latest GitHub release by itself.
7. Clean up without being asked, on the Mac and on minipc: remove merged
   worktrees (`scripts/prune-worktrees.sh --apply`) and unused memnoter sibling
   checkouts, delete merged local branches with `git branch -d`, stop leftover
   dev servers and test browsers, and delete proof files and old temp folders.
   Keep anything with uncommitted or unpushed work or an active session. The
   report names both machines and what you kept on each. The orchestrator owns
   this step, including for work its delegates did.

**Testing sessions (pair-fix).** Every brief starts with: "Fix and show only.
No tests, reviewers, sol loops, simulator passes or CI waits." Show the fix by
saving into the running `pnpm dev:copy` checkout, or by installing straight to
the device the user is testing on; the user is the tester. One cheap check
stays: before handing over a device build, take one screenshot of the exact
state the user reported, on that build. It should take a minute or two; if it
would take longer, skip it and say so. Batch related fixes into one device
build. The editor scroll/caret exception in `apps/shared-ui/AGENTS.md` still
applies.
Split the user's feedback by file area into as many parallel delegates as it
splits into, and show each fix as soon as it lands; edits that touch the same
files stay with one delegate. These delegates don't build, so the heavy cap
below doesn't limit them.

## Ownership

Collisions cost the user more than slow work: two orchestrators on one issue,
two agents editing `RootView.swift` in one checkout, builds of a checkout with
someone's half-finished edits.

- One owner per issue and per area of code at a time. Give each delegate its own
  worktree; in a shared checkout, don't hand two delegates the same files.
- Before another thread takes over an issue, stop the old one first and say so
  in both.
- One build operator per device or simulator. It builds a named commit (a branch
  or a merge of finished branches), never a dirty shared checkout, and reports
  the build stamp.

## Threads

The orchestrator decides how work splits; the user doesn't have to.

- One thread per outcome, titled after it. Its first message states the outcome,
  the baseline (where things are now, measured if it's a number) and the stop
  condition.
- A bug found along the way gets its own branch and thread, not the current
  PR. Tell the user it was split off.
- Experiments get a timebox and a fail-closed result: no receipt (numbers,
  logs) means it didn't work. Report when the goal looks unreachable instead of
  continuing.

## Linear

- Linear goes through the `agentline` MCP tools only (the `agentline-linear`
  skill), so everything agents post shows as Agentline, not as the user.
- Waiting on the user (a question, or an issue in **In Review**): call
  `issue_watch` with your thread and machine. Their reply arrives as a new
  message in that thread. Don't schedule polling checks.
- An issue waiting on the user (a question or a visual approval) gets the
  `Needs input` label; remove it as soon as they reply.
- Before moving a batch forward, re-read its issues' states and new replies.
  An issue the user moved back to **In Progress** goes back to work, whatever
  was approved before.
- Agentline comments lead with the result or the decision needed, then only
  the evidence link or next step. No long write-ups.
- Create Linear issues only when the user explicitly asks. During live pair
  sessions, track feedback by the user's item numbers in briefs and replies;
  do not create issues or upload their screenshots to Linear automatically.
  When requested, use team **I build (PRI)** and project **memnoter.com**.
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

- Default workhorse: gpt-6.2-sol via `delegate_task`. Delegate by default, small
  fixes in a live pair session included (split as in "Testing sessions"), in
  the checkout the demo runs from. Keep briefs, merging, demo restarts and
  reporting for yourself.
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
2. **Done means**: copied from the Linear issue, or the user's words if there is
   none, with the platform and evidence level. Name one platform until the user
   has approved the feature; porting is a later brief.
3. **Where**: checkout or branch, and whether to commit.
4. **Mode**: normal, or the pair-fix line from "Testing sessions", first.
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

- When the user repeats a direction or corrects how agents work, add it to a
  guide. Only rules the user stated or approved: never
  write an agent's own interpretation or an experiment into a guide. What a
  feature does goes in its Linear issue's Decisions, not a guide. Put the rule
  in the narrowest guide (`apps/*/AGENTS.md` before the root file, this file for
  orchestration only), in the same change. Memory alone doesn't reach
  delegates.
- Keep the guides short. Remove a rule when it stops being true.
- READMEs describe how to build, run and test, plus a short architecture note.
  Verification logs, screenshot lists and design narration go in the PR
  description, never a README. Tell delegates the same when they touch docs.

## Flows

- In numbered pair-session feedback, preserve the user's item numbers in replies
  and follow-up work as new items are added, so each change stays easy to identify.
- **User present** ("just fix", screenshots, testing on a device): the
  `pair-fix` skill.
- **Handoff** (issues to fix alone, with proof at the end): the `handoff` skill.
- **Lag, freezes, slow typing**: the `perf-investigate` skill.

The skills are general; the per-platform details below are what they look up.

Handoff in this repo: Linear team I build (PRI). An agent waiting on the user
comments on the issue, adds the `Needs input` label (see Linear above) and
watches the issue (`issue_watch`). Each
issue gets its own branch in the main checkout, but PRs are batched (Ship flow
step 3), not one per issue; add a worktree only to work issues in parallel, and remove it once the
branch is pushed.

## Platforms: show, prove, profile

Prototype recordings use the latest `origin/main` as their base. Fetch and
compare before recording; preserve local edits when updating the checkout.

| Platform | Show the user | Proof (video or screenshot) | Cost |
| --- | --- | --- | --- |
| Mac desktop | `pnpm dev:copy`; save and it reloads | `screencapture -v -V <secs> out.mov` once T3 Code has Screen Recording permission | cheap |
| Windows | no Windows machine; Chromium stands in | `PROOF_DIR=<dir>` on a shared-ui test (below) | cheap |
| iPad / iPhone simulator | build for the simulator (below) | `agent-device record start --scope device <file>.mp4`, then `record stop` | expensive (iOS build) |
| User's iPad / iPhone | `scripts/ios-install.sh [--iphone\|--all]` | only the user can record | expensive |

- **Handing back for the user to test:** the change is already running where
  they'll test it (`pnpm dev:copy` reloaded on the right branch, or installed
  on the named device with its build stamp). Confirm it launched, or say
  exactly what to open. Say what to open, what to do and what they should see.
  When they ask for comparison proof, give a matched before/after for every
  item.
- **Cheap** checks: do them yourself. **Expensive** ones on platforms the issue
  didn't name: ask first.
- **Chromium/WebKit proof:** `PROOF_DIR=<dir>` makes every page a shared-ui test
  opens record a `.webm` into `<dir>`. Write a throwaway test for the scenario if
  no existing one shows it, run it from `apps/shared-ui` with the usual
  `node … --test`, and delete it afterwards. The test must open the app's own
  entry page, not a fixture or demo wrapper ("Demo recordings" in `AGENTS.md`).
  It uses test data, so it proves the shared-ui layout and behaviour, not the
  native shell.
- **Simulator build:** `xcodebuild -project apps/ios/Memnoter.xcodeproj -scheme
  Memnoter -destination id=<udid> -derivedDataPath apps/ios/build build`, then
  `agent-device install com.vladyslavnalyvaiko.memnoter.ipad
  apps/ios/build/Build/Products/Debug-iphonesimulator/Memnoter.app`. UDIDs are
  in `apps/ios/README.md`. The recorder only writes frames when the screen
  changes, so drive the scenario while recording.
- **minipc** can make Chromium/WebKit proof only (no iOS, no macOS).
- **Uploads:** proof goes on the Linear issue, one file at a time
  (`file_upload`, then PUT within 60 s). Embed each file in the comment with
  `![what it shows](assetUrl)`, videos too, never a plain link. Delete every
  local video and screenshot after it's uploaded; none go in the repo or stay
  on the machine.

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

MCP servers added during a session (`agentline`, for example) don't load into it.
If an expected tool is missing, tell the user to reconnect it in `/mcp` or start
a new thread.
