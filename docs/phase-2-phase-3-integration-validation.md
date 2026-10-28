# Phase 2 / Phase 3 integration

Merged Phase 2 `fe5d1657d5950ca2f45af70cb1bdb93d110cd4ae` (including
reviewed Phase 1 `85236b2`) into reviewed Phase 3 `adeab62` in the existing
`phase-3-search-palette` checkout. Both histories are retained. No other
checkout, Phase 4/5, main, remote, or PR was changed. Independent review of the
Phase 1/2 merge was still ongoing when this integration was requested.

Read README and all three incoming review/validation documents, the supplied
AGENTS.md, and test-audit. No on-disk AGENTS.md exists in this checkout or its
ancestors. OpenClaw-specific test-audit tooling is absent; repository-native
Node/Cargo checks apply. No app was launched, simulator used, or real notes read.

## Merge decisions and integration repairs

- Resolved four conflicts in Rust invoke registration, root layout, CreateModule,
  and FindBar. Regenerated routeTree with Vite's TanStack plugin; Settings remains
  registered alongside the existing routes.
- Preserved native menu construction and `menu::set_editor_history` registration,
  every backup/content command, `confirm_exit`, the ExitGate and ExitRequested
  handshake, and the single SaveStatus/root menu bridge.
- All three search IPC commands now use `Db::lock()`, including its unavailable
  database guard. Direct connection locks remain only inside Db::lock and tests.
  Preserved AUTOINCREMENT migration, restore recovery, save suspension, mutation
  drain, and post-restore reload/rollback behavior.
- Preserved the transactional backfill version check, FTS query quoting, search
  ranking/lifecycle, and Find request object identity, navigation cancellation,
  fallback terms, and explicit currentIndex reset. Search requests open Find
  without reseeding from the editor selection; ordinary Find keeps selection
  seeding, replace, and next/previous shortcuts.
- Cmd+K still captures before editor handling; links retain Cmd+L. Native macOS
  Find/sidebar accelerators use the menu bridge exclusively, while browser and
  non-macOS DOM handling remains. Alt+Find and next/previous remain DOM actions.
  Cmd+K cannot open over the restore flow while flushing or suspended.
- Palette and welcome recents use the same persisted appStore list (20 entries,
  welcome still displays five); deletion prunes that shared list. Removed the
  parallel palette localStorage list. Create Module's palette/menu/welcome paths
  share one dialog callback and retain navigation to the newly created module.
- Added always-registered Settings and Back up now palette commands. Settings uses
  the existing event/navigation flow. Both backup entry points share useBackupNow,
  flush pending saves, reject concurrent backups/restores or suspended persistence,
  and invalidate the backup list. Palette errors are visible at the root.
- Stored indexing reconciles save receipts and compaction checkpoints before
  extracting Yjs text. The live editor applies reconciled QueryClient publications
  even when a raw disk read already seeded its document; Yjs application is
  idempotent and uses the existing non-autosave origin.
- Search index writes are real QueryClient mutations, so restore waits for their
  in-flight IPC. Suspension rejects new index writes, including a delayed backfill
  read completing during restore. Completed index mutations are immediately
  eligible for collection rather than retaining extracted note text for minutes.

## Validation

- `pnpm test`: 35 passed.
- `pnpm build`: passed, including TypeScript and full Vite build; existing large
  chunk warning remains.
- `pnpm tauri build --debug --no-bundle`: passed; native application compiled,
  without launching or producing a signed release bundle.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 21 passed; binary/doc targets
  also passed (zero cases).
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`:
  passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: passed.
- `git diff --check` and staged diff check: passed.
- New public-owner integration test uses mocked IPC transport, real Yjs,
  QueryClient, saveQueue, and indexStoredNote. It protects late-read receipt
  reconciliation, compaction checkpoints, mutation drain visibility, and rejection
  of late reads during suspension. Existing tests did not cross these owners.
  No production export exists solely for testing; isSuspended is used by backup,
  indexing, and palette admission.
- Negative controls temporarily removed reconciliation, mutation registration,
  and suspension admission separately, then restored production files. Each failed
  its intended assertion: empty body versus acknowledged text; zero versus one
  active mutation; three versus two index writes. Final code passes.
- Extended the existing temporary-directory SQLite backup/restore test to check
  FTS search results after restore and restoration of its pre-restore undo snapshot.
  No duplicate backup fixture or real application data was introduced.

## Independent review and native GUI gaps

Automated IPC coverage is not WKWebView/AppKit execution. Still verify with a
fully disposable native data profile that also isolates the legacy import path:

1. Menu and keyboard Find/sidebar single dispatch; Cmd+K palette, Cmd+L links,
   selection seeding, replacement, repeated same-term result opening, cancelled
   requests during note changes, and focus restoration after palette commands.
2. Native versus Yjs Undo/Redo in editor and all text fields, especially rapid
   focus transitions while asynchronous menu history routing is settling.
3. Settings and backup commands, backup error display, failed saves, restore
   suspension/drain, uploads/compaction/indexing during restore, and rollback.
4. Cmd+Q/menu Quit/window close with pending/failing saves, retry/cancel/explicit
   quit anyway, repeated requests, and quit during a live restore.

The retained crash protocol uses same-filesystem atomic renames; power-loss fsync
ordering and OS-level SQLite reopen/maintenance failures remain outside full
fault-injection coverage. Find UI lifecycle and actual native shortcut delivery
were inspected and compiled but were not exercised in a native GUI. Existing
Phase 1/2 review findings may require a follow-up after that review completes.
