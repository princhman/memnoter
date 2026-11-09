# Mac drawing editor

In a note, type `/drawing` and choose **Drawing** from the slash menu.
The native editor supports mouse/trackpad input, pen, pencil, marker,
whole-stroke erasing, undo/redo, fixed ink colors and width controls. Paper fits
the window and scrolls vertically. **Done** inserts or updates the drawing in
the note; **Close** keeps changed work as a local draft. Select an embedded
drawing, then click its pencil button or click the selected drawing again.

The Mac editor requires macOS 14 or later and uses the same versioned source
contract and native PencilKit archive as iPad. Existing native strokes remain
editable; they are not flattened into the PNG preview. A stale recovered draft
offers Save a copy and Discard local changes. Discard is also available in the
More menu whenever a local draft has changes. After confirmation it removes
only that draft and returns to the note; reopening reads the current published
source. Windows/Linux currently display drawing previews.

The app build compiles the Swift editor into a private native library. Its
NSHostingView covers the note inside the existing Tauri window; Done and Close
remove that view and return to the note in place. The window delegate remains
owned by Tauri. Rust and Swift exchange private request/result files and a
completion callback; Rust stores immutable source/preview assets and the shared
editor publishes their references.
The recovery draft is removed only after the note save is acknowledged.
Drafts and local tool/view preferences do not sync; published drawings do.

Run `bash scripts/check-mac-drawing.sh` from the repository root to exercise real
canvas input handlers, undo/redo, erasing, recovery and publication offscreen.
It also exercises the production presentation entry point in a hidden note
window, checking delegate preservation, Close, draft reopening and Done.
An optional output filename captures a synthetic canvas-authored source archive.
The iOS `testMacCanvasArchiveOpensAsEditableNativeInkOnIPad` test reads a fixture
produced by this check on Mac. This covers the native archive boundary; it does
not substitute for an on-screen or live-account sync check.

Use one Mac app copy per production data directory when verifying sync. Older
development copies with the same bundle identifier can share that database and
invalidate another copy's sync generation. Isolated development sessions can set
`MEMNOTER_DATA_DIR`; release builds use their normal app data directory.
