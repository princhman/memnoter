# Agent guide

Read this before working in the repo. Delegate briefs can say "follow AGENTS.md"
instead of re-explaining the stack, the commands or the rules below. A brief only
needs the task, its acceptance criteria, the branch, and anything that
contradicts this file.

## Stack

Memnoter is a local-first notes app with spaced-repetition flashcards.

| Path | What |
| --- | --- |
| `apps/shared-ui` | React + TipTap editor and app UI. Shared by desktop, iPad and iPhone. |
| `apps/desktop` | Tauri shell for macOS and Windows. |
| `apps/ios` | SwiftUI host for iPhone and iPad (one universal app). It embeds the shared-ui editor in a WKWebView. |
| `apps/apple-shared` | Swift code shared by the Apple targets. |
| `crates/memnoter-core` | Rust core: database, cards, sync engine, import. |
| `crates/memnoter-ffi` | UniFFI bindings for the core, used by iOS. |
| `apps/sync` | Cloudflare Worker + Durable Objects sync server (AGPL). |
| `apps/marketing` | memnoter.com. Deployed by Cloudflare from `main`. |

Most UI changes land in `apps/shared-ui` and so ship to **every** platform.

## Commands

| Command | Use |
| --- | --- |
| `pnpm dev` | Desktop app with hot reload. |
| `pnpm check:ci` | **Run before opening or updating a PR.** Runs everything CI runs (see below). |
| `pnpm check:ci --quick` | Skips the iOS build. For changes that don't touch `apps/ios`, `crates/` or the editor bridge. |
| `pnpm test` | shared-ui tests only. Run one file with `node --experimental-strip-types --import ./tests/support/register.mjs --test tests/<name>.test.mjs` from `apps/shared-ui`. |
| `cargo test -p memnoter-core` | Core tests. |
| `scripts/ios-install.sh` | Build and install on the user's real iPad (see Devices). |
| `scripts/preview-on-mac.sh` | Let the user try a branch on the Mac from another machine (see Machines). |

`pnpm check` is the older, smaller set. It skips clippy, the sync-server
typecheck and the iOS build, which caused most red CI runs, so use `check:ci`.

## How work ships

Unless the user says otherwise, finished work goes through these steps without
waiting to be told each one:

1. Commit **only your own changes** on the feature branch. Other agents often
   have uncommitted work in the same checkout. Never stage it, stash it,
   reset it or revert it. If the user asks for "everything on the branch", list
   what you'd include first.
2. Run a sol loop (the `sol-loop` skill: a gpt-6.1-sol reviewer, then fix the findings you agree with).
3. Run `pnpm check:ci`, then open a PR into `main` once you and the reviewer agree.
4. Watch CI. If it goes red, fix it yourself. Don't report "CI failed" and stop.
5. Merge when it's green, if the user approved the feature.
6. Offer release notes. Ask before tagging a release or pushing to TestFlight.

During hands-on testing sessions the user may say "just fix, don't test". Then
compile only, install the build, and skip tests, the sol loop and CI waits.
**Exception:** the iOS editor's scroll, keyboard and caret behaviour. Always
cover those with `tests/editor-host.test.mjs` and simulator typing, because
untested fixes there have repeatedly brought old bugs back.

## Product rules the user keeps repeating

- **Platform parity.** A change to shared UI behaviour or styling must be
  checked on desktop *and* iPad (and iPhone if it touches layout). Settings
  live in Settings on every platform. Example: chapter numbering is a setting,
  not a toolbar control.
- **Colour.** The accent is the `--primary` purple in `apps/shared-ui/src/App.css`
  (`Color("BrandAccent")` on iOS). Never use default
  blue, violet or a new purple shade. Primary buttons (Done, Save) are purple.
- **No decorative chrome.** No borders, dividers, outlines or bubbles unless
  there is too little contrast without them. Don't re-add an outline that was
  removed.
- **Native feel on iOS.** Use system navigation patterns and glass materials,
  not web-style bars. Keep toolbars stable: they scroll horizontally rather
  than hiding or reshuffling buttons when space runs out.
- **Contrast.** Check both light and dark mode. The user should never have to
  squint at selected or highlighted states.
- Show before/after screenshots for visual changes when the user asks to see
  options.

## Tests

- Add a regression test for a real bug, especially editor, sync and data-loss
  bugs. Prefer extending an existing test file.
- Don't add tests for one-off visual tweaks or for things the type system
  already guarantees. The user counts redundant tests as wasted compute (see
  the `test-audit` skill).
- The browser suites are timing-sensitive under load. If a test fails, rerun it
  alone before assuming your change broke it, and say which you did.

## Machines

- **Mac** (the user sits here): Xcode, simulators, the user's real iPad, the
  desktop app the user tests. Everything Apple builds here.
- **minipc** (Linux, `princhman-minipc`): TypeScript, Rust and the sync worker.
  It can't build iOS, and its local WebKit fails a few UI tests even on clean
  `main`. Don't count those as regressions.
- To let the user try minipc work on the Mac, run `scripts/preview-on-mac.sh push`
  from minipc. If no preview is running on the Mac yet, launch **one** Mac thread to run
  `scripts/preview-on-mac.sh serve <branch>`. After that the Mac follows the
  branch by itself, so later pushes need no new thread. Never start a
  long-running dev server in the foreground of a tool call.

## Load and parallel agents

- Run no more than **3 heavy delegates** (anything that runs cargo, `pnpm build`,
  the browser suites or xcodebuild) on one machine at a time. With 9–12 at once the
  Mac reached a load average of 330 and single-line edits took 20 minutes.
  Queue the rest, or send TS/Rust-only work to minipc.
- Prefix heavy commands with `CARGO_BUILD_JOBS=4` when other agents are running.

## Delegation

- A delegate's final report must contain its final result: commit SHA, verdict,
  what's left. Never end on "a test run will notify me". Finish waiting first.
- After a delegate reports, read its final message before telling the user
  anything. If it says work is still running, check its thread again before
  saying "waiting".
- If a delegate fails the same task once, take it over yourself instead of
  delegating it a second time. This matters most for hangs, freezes and
  native-only bugs.

## Devices

- The user's physical iPad Air is the default "my iPad". Install with
  `scripts/ios-install.sh`. It prints the commit it installed, and Settings →
  About shows the same build stamp, so "is this the latest build?" can be
  checked.
- When the user says "nothing changed", first compare the build stamp on their
  screen with the commit you installed, and check you installed to the device they're
  looking at.
- Simulators: use T3 device tools. Never close or reuse another agent's open
  device session. If you get `DEVICE_IN_USE`, wait or ask. Don't take it over.
  See `apps/ios/README.md` for the retained simulator ids.
