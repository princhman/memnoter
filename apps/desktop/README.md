# Desktop app

The Tauri shell for macOS, Windows and Linux. Run it with `pnpm dev`, or with
`pnpm dev:copy` to use a fresh copy of your notes instead of the real database.
`MEMNOTER_DATA_DIR` picks the data directory in debug builds only; release builds
always use the normal app data directory.

## Mac drawing editor

Type `/drawing` in a note. The native PencilKit editor (macOS 14+) shares its
source format with iPad, so strokes stay editable on both. **Done** publishes
the drawing into the note; **Close** keeps changes as a local recovery draft.
Windows and Linux show previews only.

The Swift editor is compiled into a private native library. Its NSHostingView
covers the note inside the Tauri window. Rust and Swift exchange request/result
files and a completion callback.

`bash scripts/check-mac-drawing.sh` runs the canvas offscreen (input, undo,
erasing, recovery, publication). It also writes the archive fixture that an iOS
test opens on iPad.
