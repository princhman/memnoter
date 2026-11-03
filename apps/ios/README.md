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
changes. Xcode does not rebuild either automatically. Its pre-build check fails with a
setup command if `Resources/Web/editor.html` is missing. XcodeGen includes the
Web folder through `sources` as a folder reference, preserving asset paths in
the app bundle.

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

The editor's trailing material capsule uses keyboard frame notifications for both animated placement and visibility, including the hardware shortcut bar, and hides for an
undocked/floating keyboard. All formatting tools stay in one horizontally scrolling
row with a stable available-width capsule and a native scroll indicator.
The material capsule is 38pt tall; 30pt visible buttons use transparent padding
for 44pt vertical touch targets. Decorative capsule layers ignore hit testing so
horizontal pans and taps reach the scroll row rather than its border overlay.
The row is a UIKit UIScrollView hosting the SwiftUI buttons. It cancels button
touches when a pan wins and does not delay taps.
Bold, italic, underline, bullets and inline math lead so frequent actions remain
visible in narrow windows; styles and the remaining grouped tools follow. Tapping
formatting actions preserves the editor selection and first responder.
Link URL entry temporarily takes text focus and returns it to the editor on
Apply. Section focus is available from body text inside the innermost containing
section and retains the caret when entered. Photos insertion and undo/redo live in navigation; saving/failure status
appears there only while needed. It is not a custom UIKit inputAccessoryView. Chapter numbering reloads editor providers after
flushing to invalidate cached preferences. Search covers core-indexed notes;
older notes need opening to refresh their index. Home mirrors the desktop welcome screen, with up to five recent modules and
muted iPad keyboard shortcuts. Recently opened modules are remembered locally.

The asset catalog uses `brand/icon-purple-1024.png` for the opaque iOS icon
and `brand/icon-purple-256.png` for the welcome mark. Dark artwork composites
`brand/icon-reversed-transparent.png` over system dark gray; the tinted icon
is a grayscale version of that artwork. iPadOS supplies the icon corner mask.

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


Home/icon follow-up: XcodeGen and simulator/device builds passed. Both builds
were installed, including the physical iPad `00008101-0013399E0CD8001E`.
The retained simulator showed the app full screen; New module opened its dialog
and a Recent row opened its note. Screenshots are in `build/screenshots/`:
`08-home-light.png`, `08-home-dark.png`, and `09-home-screen-icon.png`.
The device tool reported successful portrait rotation but the simulator stayed
in landscape, so portrait layout still needs a manual check. The Device panel
was closed without shutting down the retained simulator.

Formatting follow-up: XcodeGen, simulator build and signed device build passed.
Installed and launched on physical iPad `00008101-0013399E0CD8001E`. Captured
`12-formatting-before.png`, `13-formatting-light.png`, `14-formatting-dark.png`,
`15-format-panel-light.png` and `15-format-panel-dark.png` in build/screenshots.
Verified docked software keyboard and hardware shortcut bar placement; panel
Body/Italic actions updated live states without losing editor focus, and typing
continued at the retained caret with italic applied. Floating keyboards are
excluded by the docked-frame check; floating keyboard interaction and link URL
entry were not manually exercised. Simulator restored to light and left running.

Format-panel visibility follow-up: simulator and signed device builds passed;
installed and launched on physical iPad `00008101-0013399E0CD8001E`.
Screenshots `16-before-keyboard.png`, `17-after-keyboard.png`,
`18-panel-landscape-dark.png`, `19-focused-h2.png`, `20-focused-h3.png`,
`21-panel-light.png`, `22-shortcut-strip.png`, and `23-keyboard-hidden.png` are in
`build/screenshots/`. Verified H2 focus through the panel and H3 focus through
the bar, plus Show whole note. The bar stays available with the minimized
hardware-style shortcut strip, and Hide keyboard removes it with the strip.
The panel scrolls within a height capped at
350pt and the available editor height minus keyboard overlap and 100pt for
the bar, gap and margins. On an 820pt landscape iPad Air this leaves roughly
200pt with the docked keyboard shown in the supplied screenshot; content stays
below navigation and scrolls internally. Smaller-device sizing was checked
from this geometry, not on a separate simulator. Neutral states checked in
light and dark. Restored light mode and closed the Device panel without
shutdown. No web bridge changes were needed.


View persistence follow-up (80): the host now stores shared per-module view state
in UserDefaults, injected before editor mount, because the custom scheme cannot
rely on Web Storage. Open/flush capture pending view saves. Native preferences
also retain the selected destination and sidebar visibility. Web regression
fails before the fix and passes after; TypeScript, lint, all 141 tests and the
web bundle build passed. Simulator and signed device builds passed, and the
physical iPad install and launch succeeded.

On Memnoter iPad Air (E3D6F644-C5D2-4C12-8A20-69F065491CD1), horizontal swipes
scrolled both the baseline and UIKit rows with the sidebar open; UIKit also
scrolled with it hidden. Quote and heading taps applied formatting after swipes.
The original physical-device failure was not reproduced, so its exact cause
remains unconfirmed. Screenshots: build/screenshots/80-before.png,
80-baseline-after-swipe.png, 80-uikit-before.png, 80-uikit-after.png,
80-wide-before.png, 80-wide-after.png. Long-text entry exceeded the device
runner watchdog; its prescribed coordinate retry also failed while draining.
Full module-switch/relaunch view restoration remains unverified on simulator.
The Device panel was closed without simulator shutdown.
