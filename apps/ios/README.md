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
