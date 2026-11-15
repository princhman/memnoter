# Memnoter for iPhone and iPad

A universal SwiftUI app (iOS/iPadOS 17+), bundle ID
`com.vladyslavnalyvaiko.memnoter.ipad`. That ID is kept for existing installs.
It uses the Rust core through UniFFI and embeds the shared-ui editor in a
WKWebView. Data lives in Application Support/Memnoter (`main.db`, `files/`,
`backups/`).

## Build

You need Xcode with the iOS SDK, xcodegen, Rust with the `aarch64-apple-ios` and
`aarch64-apple-ios-sim` targets, Node and pnpm. From the repo root:

```sh
./scripts/build-ios-core.sh      # Rust core → XCFramework + Swift bindings
./scripts/build-ios-web.sh       # shared-ui → Resources/Web
(cd apps/ios && xcodegen generate)
```

Xcode rebuilds neither the core nor the web bundle. Rerun the core script after
`crates/` changes and the web script after shared-ui changes. Rerun xcodegen
after editing `project.yml` or adding files. Only `project.yml` and
`Package.swift` are committed; the generated project, bindings, XCFramework and
web resources are ignored. There are no Intel simulator slices.

## Install on a device

```sh
scripts/ios-install.sh            # iPad Air
scripts/ios-install.sh --iphone   # iPhone 11
scripts/ios-install.sh --all      # both, one build; add --core after crates/ changes
```

It prints the build stamp that Settings → About shows.

## Isolated question bank development on iPad

This is an explicit local Debug opt-in. From the repository root:

```sh
scripts/ios-install.sh --ipad --question-bank-dev
# Add --live to use the running pnpm dev:device server.
```

Question banks and worksheets are enabled in normal Debug and Release builds,
including with sync. This option only selects a separate offline development
vault and preferences. Add `--core` when Rust sources changed. The usual
Release/TestFlight core build remains `scripts/build-ios-core.sh`.

For an already installed Debug app/core, an explicit physical iPad relaunch is:

```sh
xcrun devicectl device process launch --terminate-existing \
  --device 00008101-0013399E0CD8001E \
  com.vladyslavnalyvaiko.memnoter.ipad --question-bank-dev
```

For simulator testing, prepare the core with `scripts/build-ios-core.sh --debug`
and build the Debug app for the retained iPad UDID below. Use T3 `device_open`
and its returned `agent-device` command to install/open the app, supplying
`--question-bank-dev` as an app launch argument (consult `help open` for syntax).
For Xcode, put that argument in Scheme → Run → Arguments Passed On Launch.

Before opening the core, native startup provisions only the fixed sandbox path
`Application Support/MemnoterQuestionBankDevelopment/v2`, outside `Memnoter`.
It creates a path-bound `.question-bank-development` marker only for a newly
created vault and sets `MEMNOTER_DATA_DIR` to its canonical path. Existing
unmarked, moved or redirected directories cause startup to fail;
there is no fallback to the real vault. The directory is excluded from device
backups. Preferences use the separate `com.memnoter.question-bank-development.v1`
suite. The sync coordinator is not created, so no Keychain login is loaded, and
the core marker also blocks `sync_enable`. UI-test vault arguments cannot be
combined with this mode. Release apps refuse this launch argument.

The first launch is **empty**: no real vault or desktop fixture is read or
copied, and no questions or PDFs are preloaded. Create a module and bank content
through the existing UI/APIs (`create_module`, then `question_bank_edit`), or
import test PDFs through the existing document APIs. Subsequent flagged launches
reuse this disposable vault; it is not automatically cleared. Native views can
identify the session with `AppStore.questionBankDevelopment`, and access its
selected path through `AppStore.directory`.

The opt-in is per launch. A Home Screen launch or an install without the option
opens the normal vault and may migrate it as usual. The app keeps its existing
bundle ID, so the development install replaces the installed app, while leaving
the normal vault untouched during flagged launches. Use the explicit flagged
relaunch above throughout bank testing; this option is not a persistent switch.

## Live shared-ui development

Run `pnpm dev:device` on your Mac, then in another terminal run
`scripts/ios-install.sh --live` (add `--iphone` or `--all`). Keep the server
running and the Mac and devices on the same trusted LAN; allow Local Network
access when prompted. Set `IOS_DEV_HOST` / `IOS_DEV_PORT` to override LAN
address detection / port. The command prints the editor URL.

After this one Debug install, shared-ui edits reload in seconds. Reload waits
for pending note, image and PDF writes; failed saves pause reload. React HMR is
disabled to preserve edits. Review reloads its scope; its in-memory undo history
resets. An unreachable server loads the bundle with a small debug note; relaunch
to retry live mode. Native/Rust/bridge protocol changes still need a rebuild.
A normal install uses the bundle. Release/TestFlight contain no dev URL, ATS
exception or Local Network usage description.

For simulator builds, pass `-configuration Debug MEMNOTER_EDITOR_DEV_URL=<URL>`
to xcodebuild after the normal core/web preparation and xcodegen steps.

## Simulators

Use the retained simulators, and don't create task-specific ones:

| Device | UDID |
| --- | --- |
| iPad | `11A89810-6F0B-48A8-8A30-B699FDB4C5F0` |
| iPhone | `A1073BD7-C9C6-4908-A9A5-36C5C5F1FEA5` |
| Large iPhone | `651B2A54-415D-4E68-A787-E6BAE0BCAF5A` |

Drive them through T3 `device_open` (hostId `local`), never simctl UI commands,
and never close or reuse another agent's session.

## Tests

```sh
cd apps/ios
xcodebuild -project Memnoter.xcodeproj -scheme Memnoter \
  -destination id=11A89810-6F0B-48A8-8A30-B699FDB4C5F0 \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO test
```

Add `-only-testing:MemnoterUITests/PhoneNavigationUITests` with a phone UDID
for the phone scenario. `SectionFocusUITests` covers Contents and focus on both
devices.

- **Sync E2E** (`testTwoNativeDatabasesMergeConcurrentYjsEdits`) needs a local
  Worker on port 8787 with `DEV_RETURN_CODE=1` in `apps/sync/.dev.vars`. Start
  it with `pnpm dev:sync`. The test skips if the Worker is unreachable.
  For a test-owned Worker with auth readiness checks and cleanup, run from the
  repository root after building the app dependencies:

  ```sh
  ./scripts/ensure-sync-vars.sh
  node scripts/ios-test-with-worker.mjs xcodebuild test \
    -project apps/ios/Memnoter.xcodeproj -scheme Memnoter \
    -destination id=11A89810-6F0B-48A8-8A30-B699FDB4C5F0 \
    -derivedDataPath apps/ios/build -parallel-testing-enabled NO
  ```

- **Keychain:** unsigned builds (`CODE_SIGNING_ALLOWED=NO`) can lack Keychain
  entitlements. Those tests then skip on `errSecMissingEntitlement` only. Leave
  out that flag for real Keychain coverage.

## Architecture

- `CoreClient` is an actor; all Rust calls run off the main actor.
- `WebSession` keeps one editor across module switches and serializes
  open/flush. Navigation waits for the flush.
- The editor loads from `memnoter-app://localhost/editor.html`. Files are served
  by the `memnoter-file` handler, which validates paths and sniffs image types.
- Review renders cards in a small `review-native.html` web view (KaTeX, clozes,
  masks, ts-fsrs). Swift owns the queue, rating, undo and shortcuts.
- The formatting row above the keyboard is a UIKit `UIScrollView` hosting
  SwiftUI buttons, positioned from keyboard frame notifications.
- Drawings use PencilKit and the same versioned source/preview format as the Mac
  editor (see `apps/desktop/README.md`). Recovery drafts stay local.
- iPhone shares everything with iPad. Phone navigation drives the collapsed split
  view itself so it can wait for the save barrier before opening a note.
