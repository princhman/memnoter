# Memnoter for iPad

Native SwiftUI iPadOS 17+ host, bundle ID `com.vladyslavnalyvaiko.memnoter.ipad`.
The desktop/Tauri project (including `src-tauri/gen/apple`) is independent.
Data lives in Application Support/Memnoter: main.db, files/, backups/.

## Build

Prerequisites: Xcode with iOS SDK, xcodegen, Rust with
`aarch64-apple-ios` and `aarch64-apple-ios-sim`, Node and pnpm.
From the repository root:

```sh
pnpm install --frozen-lockfile
./scripts/build-ios-core.sh
./scripts/build-ios-web.sh
cd apps/ios
/opt/homebrew/bin/xcodegen generate
xcodebuild -project Memnoter.xcodeproj -scheme Memnoter \
  -destination id=11A89810-6F0B-48A8-8A30-B699FDB4C5F0 \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

`build-ios-core.sh` builds both ARM64 device and Apple Silicon simulator static
libraries, generates UniFFI Swift from the host library, and replaces the local
Swift package's XCFramework and bindings. It is safe to rerun. Intel simulator
slices are not included. Do not link system sqlite3: Rust bundles SQLite.
`build-ios-web.sh` builds and copies the complete Vite output to Resources/Web.
Rerun it after shared editor/frontend changes. Rerun the core script after Rust
changes. Xcode does not rebuild either automatically.

`project.yml` and Package.swift are committed; generated Xcode projects,
bindings, XCFrameworks, web resources and build products are ignored. Run
xcodegen after changing project.yml or adding source files. For a physical iPad,
open the generated project in Xcode and choose your development signing team.

## Install and run on the shared simulator

First confirm the retained iPad is idle; never close or reuse another agent's
active device session. Install after building:

```sh
xcrun simctl install 11A89810-6F0B-48A8-8A30-B699FDB4C5F0 \
  apps/ios/build/Build/Products/Debug-iphonesimulator/Memnoter.app
```

From the repo root, use T3 `device_open` with hostId `local` and deviceId
`11A89810-6F0B-48A8-8A30-B699FDB4C5F0`. Run the returned command with:

```sh
<returned-agent-device-command> open com.vladyslavnalyvaiko.memnoter.ipad --relaunch
<returned-agent-device-command> snapshot -i
```

Alternatively choose the retained iPad in Xcode and Run when it is available.
Do not use simctl for UI actions or create task-specific simulators.

## Validation

```sh
cargo test --workspace
npx tsc --noEmit -p .
pnpm lint
pnpm test
pnpm build
cd apps/ios
xcodebuild -project Memnoter.xcodeproj -scheme Memnoter \
  -destination id=11A89810-6F0B-48A8-8A30-B699FDB4C5F0 \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO test
```

The Swift integration test uses a temporary real Rust core, with Unicode module
creation, camelCase mutations, snake_case responses, binary upload, reopen and
errors. Rust tests cover the exported FFI persistence/error boundary. Run tests
only while the shared simulator is idle.

Manual acceptance: create a module; type headings and Q :: A cards; switch away
and relaunch; verify text; insert a Photos image; use outline scroll/fold;
review globally and per module with Space, 1–4 and undo; search; create and
restore a backup. Also check software/hardware keyboard layout and background
save behavior on a physical iPad.

## Architecture and current limits

CoreClient is an actor; opening and all Rust work run off the main actor.
WebSession follows docs/native-bridge.md with decoded JSON replies and safe JS
arguments. It retains the editor across module switches, serializes open/flush,
and requests a background task for the lifecycle barrier. Navigation waits for
flush and reports failures. No mobile host can guarantee completion after a
force kill or immediate OS termination; ordinary editor writes remain active.

The bundled editor uses `memnoter-app://localhost/editor.html` for relative ES
module assets. The separate `memnoter-file` handler decodes components once,
rejects traversal and encoded separators, handles cancellation, reads files off
main, and detects image MIME types (including HEIC) from bytes. External HTTP,
HTTPS and mail links open with the system. The bridge error UI reports failures.

Review uses a small `review-native.html` WKWebView for shared CardFace rendering
(KaTeX, clozes, occlusion masks) and the canonical ts-fsrs scheduler. Swift owns
the queue, Codable scheduling models, rating persistence, undo, buttons, haptics
and shortcuts. It checks due cards again every 15 seconds when the queue is
empty. It currently supports one rating undo, no redo or interval previews, and
requires older/imported notes to be opened once for card indexing. It does not
port desktop learn-ahead/preferences or card backfill. Review face segments are
Codable JSON because their schema varies by card kind.

The editor's formatting row follows the keyboard through SwiftUI's keyboard
safe area. It provides common marks, headings, lists, math, card creation and
Photos insertion. It is not a custom UIKit inputAccessoryView. Native link
editing is not exposed yet. Chapter numbering reloads editor providers after
flushing to invalidate cached preferences. Search covers core-indexed notes;
older notes need opening to refresh their index. Home is a welcome screen.

## Verification in this implementation session

Passed: ARM64 device/simulator core builds, Swift 6 simulator app build, one
Swift real-FFI integration test, Rust workspace tests (43 tests), TypeScript,
lint, all 140 JavaScript tests, Vite production build. Build/test logs are under
`/tmp/memnoter-*.log` on this Mac (ephemeral).

The app was installed on the retained iPad. Manual UI verification was blocked:
agent-device returned DEVICE_IN_USE for another session, including after its
supported wait retry. That session was not reused or closed. No screenshots
were captured, and note entry/relaunch persistence, Photos insertion, outline
interaction, review interaction and restore UI remain unverified. The iPad was
already booted and was left running.
