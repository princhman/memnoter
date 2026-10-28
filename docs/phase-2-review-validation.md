# Phase 2 review fixes

## History routing

The Edit menu starts with predefined Undo and Redo. Once the editor's menu
listener is ready, DOM focus changes invoke `set_editor_history`. While the
ProseMirror root owns focus, the native command replaces that pair with custom
Undo/Redo items emitting `editor-undo`/`editor-redo`; the focused editor invokes
the Yjs undo manager directly. Inputs, textareas, and other controls (including
controls inside editor node views) restore the predefined pair. Unmount also
restores it. Focus commands are serialized across editor instances so an older
focus request cannot finish after a newer blur/unmount request.

The old pair is removed before attaching the replacement: only one Cmd+Z and
Cmd+Shift+Z menu pair is installed. Existing Collaboration keyboard handlers
remain; a handled key is prevented by ProseMirror, while an AppKit menu action
emits one explicit history event. The beforeinput history bridge was removed,
so it cannot replay an undo already handled by the menu. Cut, Copy, Paste,
Select All, and Quit remain predefined.

Static API evidence inspected in the installed dependency sources:

- Tauri 2.12.5 `menu/predefined.rs` exposes predefined undo/redo;
  `menu/submenu.rs` exposes `items`, `remove_at`, and `insert_items`.
- muda 0.20.0 `platform_impl/macos/mod.rs` maps predefined history to `undo:`
  and `redo:`. Ordinary menu items instead target their own `customAction:`
  and emit `MenuEvent`; they do not depend on WebKit's undo selector validation.
- WebKit's [WebViewImpl.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm)
  registers native edit commands with the view's NSUndoManager. Yjs-only
  transactions do not register there. A beforeinput callback cannot make a
  disabled native menu item actionable.

This is source inspection and compilation evidence, **not native GUI proof**.
No native app was launched, and no AppKit menu clicks or WKWebView keyboard
sequences were exercised during this fix. Before release, verify in macOS:

1. Insert a heading through the slash menu with no native typing history;
   click Edit > Undo, then Redo. Each click should perform one Yjs operation.
2. Repeat using Cmd+Z/Cmd+Shift+Z, including empty history; verify no double undo.
3. Switch to rename/find/settings text fields, type, then use menu and keyboard
   undo/redo. Check Cut/Copy/Paste/Select All there and in the note.
4. Rapidly switch focus and immediately open Edit or invoke history. Focus
   synchronization crosses asynchronous IPC; immediate actions during that
   transition remain a runtime integration risk requiring native verification.
5. Switch notes and close/reopen the editor; confirm no stale history routing.

## Folding

The shared fold transaction clears section focus when relocating the caret
outside its focused range. Toggle, restored fold sets, and the fold-current
shortcut all use this owner, including the fold widget's toggle path.

`tests/heading-fold.test.mjs` exercises real ProseMirror plugins and commands.
All three cases fail without the repair (focus stays 8–21 with caret at 7) and
pass with it. Assertions inspect the owning transaction before append hooks can
mask the bug. The shortcut case also checks that folding the child preserves
focus while the caret remains inside its range.

## Phase 1 integration

Read-only verification of `t3-af5dba6c/src/routes/__root.tsx` found its listener
and cleanup both use `memnoter:open-settings`, exactly matching this branch's
`OPEN_SETTINGS_EVENT`. The Settings menu is retained; the Phase 1 `/settings`
route and listener must be integrated for it to open. No duplicate UI was added.

Phase 1 owns ExitRequested flush confirmation. This fix leaves predefined Quit
and the run/exit lifecycle unchanged. Both branches touch the invoke-handler
area in `src-tauri/src/lib.rs`; preserve `menu::set_editor_history` alongside
Phase 1's flush commands when integrating, and validate Cmd+Q with pending saves.

## Checks

- `pnpm test`: 18 passing tests, including the three folding regressions.
- `pnpm build`: passing (existing Vite large-chunk warning).
- `cargo check`: passing on this Mac, including the macOS menu code.
- `cargo test`: five passing Rust tests; binary/doc tests have no cases.
- `cargo fmt --check` and `git diff --check`: passing.
- Additional `cargo clippy --all-targets -- -D warnings`: blocked by the
  pre-existing `clippy::redundant_field_names` at `src/lib.rs:666` (`id: id`),
  outside this fix. That code was left intact.
