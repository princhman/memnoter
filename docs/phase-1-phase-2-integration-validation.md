# Phase 1 / Phase 2 integration

Merged local Phase 1 `85236b27179897336b1024c6d6fcb87c3808508f` into Phase 2
`d387bea` with a merge commit, preserving both histories. Only the existing
Phase 2 checkout was changed. Supplied AGENTS.md simulator rules apply; no
on-disk AGENTS.md was found in the checkout or inspected ancestors. Read both
phase validation documents and test-audit. No new tests or test seams were
introduced; repository-native Node/Cargo checks apply (OpenClaw-only skill
scripts are absent).

## Resolution and interaction review

- Rust invoke registration retains both macOS `menu::set_editor_history` and
  `confirm_exit`, plus every backup and content command. Phase 2's menu builder
  remains attached to Phase 1's Builder.build(...).run(...) lifecycle.
- Frontend startup retains the single native app-menu bridge and Phase 1's
  shared QueryClient, which the save queue uses to publish receipts.
- Native Settings -> `menu: settings` -> OPEN_SETTINGS_EVENT -> root listener
  -> `/settings` uses one existing action and one route listener with cleanup.
  The root now imports the bridge's event constant. No keyboard dispatch,
  extra Settings UI, or second menu bridge was introduced.
- Regenerated routeTree through the Vite TanStack router plugin before tsc;
  the generated tree contains the Settings route alongside existing routes.
- Inspected Db::lock's unavailable guard, startup recovery ordering,
  AUTOINCREMENT schema/migration, restore rollback/unavailable handling, receipt
  reconciliation, compaction watermark construction, queue suspension and
  restore mutation drain. These Phase 1 owners remain intact.
- SaveStatus mounts once at the root. Native predefined Quit still enters
  ExitRequested, which prevents exit and requests the frontend flush. Only
  successful flush or explicit Quit anyway calls confirm_exit. Close requests
  share that frontend handler; repeated requests during its flush are ignored.
- Restore still flushes, suspends persistence, waits for existing mutations,
  restores, then clears/reloads only on success; failure resumes retained saves.
- Focus-dependent menu history still serializes IPC transitions, dispatches
  Yjs undo/redo only when the editor root has focus, and restores native history
  on blur/unmount. Predefined Quit/Cut/Copy/Paste/Select All remain intact. No
  beforeinput bridge was reintroduced. The shared focused-fold repair is intact.

## Validation

- `pnpm build`: passed (existing Vite chunk-size warning).
- `pnpm test`: 27 passed, including receipt publication, save queue suspension,
  and all three focused-fold regressions.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 17 passed; binary/doc targets
  also passed, with no cases.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`:
  passed. Phase 1 already contains the redundant-field-name repair.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: passed.
- Staged/unstaged `git diff --check`: passed.

## Remaining native verification

No native app was launched and no real notes were opened. A disposable native
profile isolating both the current identifier and legacy migration source was
not established; changing only an identifier would not isolate legacy import.
No preview tools or simulators were used.

Independent review still needs disposable-data macOS verification of:

1. Settings menu and Cmd+, navigation; native Undo/Redo in text inputs and the
   Yjs editor, including node-view inputs and rapid focus/note transitions.
2. Shortcut/menu single dispatch (Undo/Redo, Find, sidebar, New Module), including
   the existing DOM keyboard fallback interacting with AppKit accelerators.
3. Cmd+Q/menu Quit/window close with queued edits, failing saves, Retry, Keep
   editing, Quit anyway, and repeated quit requests.
4. Successful/failed restore, uploads/compaction during restore, and quit during
   restore. Crash recovery has automated coverage; native scheduling and dialog
   behavior remain unverified.

As in Phase 1, filesystem rename recovery does not establish power-loss fsync
ordering; OS-level reopen/maintenance failures are not fully fault-injected.
