# Memnoter for iPhone and iPad

Universal SwiftUI iOS/iPadOS 17+ host, bundle ID `com.vladyslavnalyvaiko.memnoter.ipad`.
The existing bundle identity is retained for installed iPad apps and their data.
The desktop/Tauri project is independent; iOS uses the native project in this directory.
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

### Keychain and native Worker fixture

Unsigned simulator builds (`CODE_SIGNING_ALLOWED=NO`) may lack Keychain
entitlements. The storage test and native E2E fixture probe SecItemAdd and skip
with an explicit message only for errSecMissingEntitlement (-34018); other
Keychain errors still fail. The storage test performs real save/update/reload,
accessibility and deletion checks whenever the probe succeeds. For real Keychain
coverage, run the same test command with simulator signing enabled (omit
`CODE_SIGNING_ALLOWED=NO`; Xcode uses local ad-hoc simulator signing), or run
on a physical iPad with a configured development team.

The native two-database E2E test needs a local Worker on port 8787 with development
sign-in codes enabled. Start only the Worker (no desktop apps required):

```sh
cd apps/sync
pnpm install --frozen-lockfile
# In .dev.vars, set AUTH_SECRET to a local random value and DEV_RETURN_CODE=1.
# Never commit .dev.vars or use production credentials.
pnpm dev -- --port 8787
```

Leave it running, then run the Xcode test command above with signing enabled.
The simulator reaches the Mac Worker at `http://localhost:8787`. The fixture
creates a unique throwaway email and two temporary databases, signs in, checks
concurrent Yjs merge and sign-out retention, and removes its local data and
Keychain entries. It skips if the Worker is unreachable or Keychain entitlements
are missing; a reachable but misconfigured Worker fails the test. Worker data
persists in Wrangler's local state; use a throwaway local state directory if
needed. `scripts/sync-dev.sh` also starts this Worker, plus two desktop clients.

Manual acceptance: create a module; type headings and Q :: A cards; switch away
and relaunch; verify text; insert a Photos image; use outline scroll/fold;
review globally and per module with Space, 1–4 and undo; search; create and
restore a backup. Also check software/hardware keyboard layout and background
save behavior on a physical iPad.

## Architecture and current limits

iPhone uses the same core, sync coordinator, embedded editor, formatting row,
review and settings as iPad. Phone navigation explicitly controls the collapsed
split-view column after the shared save/open barrier succeeds. Phone rows use
buttons so SwiftUI cannot navigate before that asynchronous operation finishes;
iPad retains selection-driven links and its existing split-view configuration.
Undo/redo are visible in the phone navigation bar. The note title opens Contents
on iPhone; iPad keeps its Contents toolbar button. Both use the same hierarchical
browser: each page contains immediate child sections, and parents drill into the
next level. The native navigation title and Back button provide context without
a duplicate note-name or breadcrumb strip. Rows have no separators or disclosure
chevrons. Search
finds headings across the entire document, including folded and focused-out
sections. Tap a leaf or the jump icon beside a parent to scroll there; this reveals the target
when necessary without changing unrelated folds.

Every section has a viewfinder icon for Focus, replaced by an expand icon for
Unfocus on the focused section; parents add a go-to icon. A row's icons share
one compact 32-point system-fill capsule while keeping 44-point tap targets and
descriptive accessibility labels. The reading branch is an inset rounded card
tinted with the brand accent, not a full-width band. Liquid Glass stays on the
navigation layer: toolbar, search and a brand-tinted glass Whole Note capsule
above search (bordered before iOS 26). Search results show their ancestor trail.
The accent asset uses brand purple `#432fc8` in light mode and a lighter purple
in dark mode. Focus targets the chosen heading directly, without caret placement, and
reveals folded ancestors/content. Browsing does not focus a section. The current
reading section/branch is highlighted, with no checkmark. Whole Note appears
while focused and exits focus from any level. The old cursor-dependent focus toolbar
control and ellipsis action have been removed on both platforms. A focused note
shows its section name in navigation; iPhone also retains a direct × exit.

Contents is a medium/large sheet on iPhone and a bounded popover on iPad. The
phone WebView suppresses its form-navigation accessory through the public
inputAccessoryView override; predictions and iPad accessory behavior are
preserved. Phone Text/H1–H6 choices use one Paragraph style menu at the start of
the formatting row; iPad keeps inline choices. Other phone-only adaptations use
phone idiom rather than compact size class. No shared web styles change.

Run the phone navigation/persistence scenario on an idle retained phone:

```sh
cd apps/ios
xcodebuild -project Memnoter.xcodeproj -scheme Memnoter \
  -destination id=A1073BD7-C9C6-4908-A9A5-36C5C5F1FEA5 \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO \
  -only-testing:MemnoterUITests/PhoneNavigationUITests test
```

Use `651B2A54-415D-4E68-A787-E6BAE0BCAF5A` for the retained large phone.
The scenario isolates its database/preferences, exercises real editing, native
Back, reopening the current note, relaunch persistence and flashcard reveal/rating. It
skips on iPad. `MemnoterUITests/SectionFocusUITests` is the shared phone/iPad
Contents scenario: it exercises drill-down, reading-branch highlighting, direct
focus, deeper focus, search, Unfocus, whole-note exit and relaunch persistence.
Run it with the same command and its selector, using the retained tablet UDID
when that device is idle. `ContentsHierarchyTests` covers skipped heading levels,
repeated titles and a 9,000-heading tree.

CI temporarily excludes only
`SectionFocusUITests/testContentsHierarchyFocusAndUnfocusRestoreWholeNote`:
it intermittently times out observing the reading-branch highlight after focus,
despite passing local simulator runs. Local commands still run the scenario.
Remove the CI exclusion once that instability is resolved. Native unit tests and
the mandatory two-database sync E2E test remain enabled.

### Editable drawings

In a note, choose **Note actions > Insert drawing**. Draw in the native
PencilKit canvas with a compact custom toolbar (pen, pencil, marker, fixed
ink colors, stroke width, erasing and lasso). Paper and drawing controls keep
a light appearance with literal ink colors, including when the app uses dark
mode. Floating Close, Done and options controls replace the navigation/status
bar. Drawing options includes finger
input, **Save a copy**, and geometry export. Paper fits the available width
and scrolls vertically. Pinch zoom and horizontal panning are disabled; more
blank paper is added automatically as writing or scrolling approaches the bottom.
The selected tool, ink, width and finger-input preference are remembered on this
device. Each drawing restores its own vertical position in document coordinates,
including after rotation or app relaunch. These viewing preferences do not sync.

**Done** saves the editable source and preview into the note. The first tap on a
drawing selects it; tap it again or use the pencil button to reopen and update
that same embed. Pencil and Delete stay together in the selection toolbar while
other controls scroll horizontally when necessary. Returning from the canvas
leaves the drawing deselected. Stroke-width options contain only width controls;
ink colors live in the main toolbar. A note can contain multiple independent
drawings. **Close** retains changed work as a local recovery draft; reopen the
embed and choose Done to publish those changes. An untouched new drawing is
removed when closed. Missing or corrupt sources never open as writable empty
drawings; Retry can reopen a source that has finished downloading.

Published source documents and PNG previews use immutable managed files and
the normal encrypted file sync and backup paths. One versioned image attribute
stores the source/preview pair. The core independently protects both assets
from startup cleanup, including copies in other notes and retained undo history.
Local recovery drafts are not synced or included in app backups. Drawing
concurrency is revision-level: observed stale saves are rejected, with Save a
copy available. Offline stroke-level merging is not implemented.
Checkpoint encoding, source decoding, geometry export and preview rendering use
immutable PencilKit snapshots off the main actor. A published checkpoint cannot
be resurrected by a late autosave or remove newer recovery data. Publication
enforces the sync protocol's 50 MB encrypted-file limit; an oversized drawing
keeps its local recovery draft and offers the existing stroke export action.

The earlier per-note prototype scratchpad remains available through **Import
scratchpad** in notes that have one. Import creates an editable embed and leaves
the original scratchpad intact. Images inserted by the earlier prototype remain
ordinary snapshots.

On Mac, insert drawings with the `/drawing` slash command. On iPad, use
**Note actions → Insert drawing**. Select a drawing and use its pencil button (or
click the selected drawing again) to edit with the native mouse/trackpad canvas.
Pen, pencil, marker, whole-stroke eraser, undo/redo, fixed colors and stroke width
operate on the same editable PencilKit archive as the iPad. Mac Close retains a
local recovery draft; Done publishes a managed source/preview pair. Windows and
Linux currently display previews and preserve editable source references.
Clients predating the drawing schema/reference handling have not been
validated for editing these notes. Source documents retain native PencilKit
data; iPad publication also includes an optional geometry export for future adapters. Cross-renderer
editing and stroke equivalence are not yet implemented.

An isolated two-core test transfers the source/preview pair, edits the note on
the second peer, transfers it back and reopens the source after restart. A
desktop WebKit test independently verifies preview display and source-reference
retention through text editing and reopening. These are not a live-account
iPad-to-Mac cloud verification. A subsequent live-data investigation reproduced
the storage failure: valid updates containing both new structs and their
deletions were incorrectly rejected before applying the structs. The guard now
checks the resulting state while retaining same-payload foreign asset references
for undo. The original missing/out-of-order-history guards remain active.

### Editor host

CoreClient is an actor; opening and all Rust work run off the main actor.
WebSession uses decoded JSON replies and safe JS
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


Input-assistant follow-up (95): the host clears leading/trailing
`inputAssistantItem` button groups on the web view and its content responder
before loading, after navigation, and on keyboard show/frame changes. This uses
public UIKit APIs only. Paste, Copy and Cut now live after the first formatting
group and use WebKit's native editing actions; undo/redo remain in navigation.
Keyboard placement still follows the reported destination frame, with a bottom
anchor when a hardware keyboard's empty assistant frame falls below the window.
Predictive text, autocorrect and spellcheck are unchanged. If predictions retain
a system row, offer an explicit editor autocorrect/spellcheck setting rather than
silently disabling them.

Both simulator and signed physical-device builds passed. Runtime verification
is pending: agent-device returned DEVICE_IN_USE twice for the dedicated iPad Air
(including its wait retry). Its other session was left untouched; simulator
installation, screenshots, Paste interaction and the existing XCUITest were not
run to avoid interrupting it. Still check predictions on/off, software/hardware
keyboards, Copy/Cut/Paste with rich content, and keyboard-edge alignment. No
`95-…` screenshots were produced in this session.
