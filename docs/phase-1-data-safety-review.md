# Phase 1 data-safety follow-up

Scope: existing phase-1-data-safety worktree only. No Phase 2 edits, push, PR, simulator, or real application data was used. No on-disk AGENTS.md was found in this worktree or its inspected ancestors; the supplied AGENTS instructions apply. Test-audit was read before testing. Its OpenClaw-only scripts/skills are absent here; validation uses this repository's pnpm/Node and Cargo commands.

## Repairs

1. Startup settles an interrupted restore before legacy migration can create a live main.db. initialize_data is the production startup boundary exercised by the regression.
2. Save receipts are journaled independently of QueryClient cache existence. The content query reconciles receipts at QueryClient publication, so a stale outstanding read cannot overwrite them. Compaction first applies all cached updates to its Y.Doc before choosing the watermark. Successful compaction retires the exact receipt objects represented in its snapshot and retains a checkpoint for overlapping stale publications. Object identity matters because SQLite can reuse update IDs after compaction.
3. Once restore recovery finishes, restore-old is atomically renamed to restore-cleanup before recursive deletion. Partial deletion of restore-cleanup cannot be interpreted as rollback data. Interrupted prune deletion also uses an ignored .partial name. Ambiguous residue from the previous cleanup protocol fails startup with a recovery message rather than mixing databases and images.
4. Restore requires a successful save flush, suspends new queue persistence, waits for in-flight IPC and existing mutations (including images/compactions), then invokes restore. Failed restore resumes the retained queue. Only confirmed success discards queued edits and reloads. The modal blocks editor interaction during this handoff.
5. Backup IDs advance beyond the newest retained snapshot even when the wall clock moves backward. New and pre-restore undo snapshots therefore survive retention. created_at reflects this logical monotonic timestamp and may be ahead of the wall clock after rollback.
6. RunEvent::ExitRequested synchronously prevents exit until the frontend completes the same flush/confirmation used for close requests. The explicit confirm_exit command opens a one-way exit gate. Repeated requests share an in-progress frontend flush.
7. Post-commit cleanup/prune failures are logged maintenance errors; a successful restore still resolves successfully and reloads its frontend. Pre-commit rollback failures remain errors.
8. A missing live database or failed reopen returns an explicit restart-required error. The shared Db is marked unavailable while its lock is held; every database command subsequently fails through Db::lock rather than using the temporary in-memory connection. Startup recovery never silently creates a replacement when restore recovery has failed.

## Evidence

- pnpm build: passed (existing Vite large-chunk warning).
- pnpm test: 24 passed.
- cargo test --manifest-path src-tauri/Cargo.toml: 15 passed, plus binary/doc targets.
- cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings: passed.
- git diff --check: passed.
- Real QueryClient deferred-read regression proves an acknowledged Yjs update survives stale publication, reopening, compaction receipt retirement, and a later stale publication.
- Save-queue regression proves suspension waits for an outstanding write, blocks later writes, and retains them for rollback/resume.
- Temporary-directory SQLite regressions cover recovery before legacy import, clock rollback plus restoring the actual undo state, committed cleanup leftovers, interrupted rollback, and existing successful restore/image consistency.
- Negative controls temporarily disabled only the relevant repairs, then restored the files: stale QueryClient publication failed with empty reopened text; startup order failed with legacy state [1] instead of recovered [2]; clock ordering failed to restore undo state [2]; disabling suspension wrote the queued 'during' edit before restore. All four controls failed for the intended assertions.

## Assumptions and remaining verification

The crash protocol covers process interruption with atomic same-filesystem directory renames. It does not claim power-loss durability without filesystem fsync ordering. Tests use UUID temporary directories and mocked IPC transport with real QueryClient/Yjs; no actual user's database or images are opened. Reopen failure protection is covered by the unavailable database gate, but an OS-level SQLite reopen failure was not injected end to end. Maintenance permission failures and every individual filesystem crash instruction were not fault-injected.

Native Cmd+Q/menu Quit, the actual webview dialog, close/retry/cancel flows, and quitting during a live restore still require a disposable-data native GUI smoke test. No app was launched against user data. If the webview cannot receive an exit event, native exit stays blocked rather than silently losing edits.

## Phase 2 integration contract

Keep the Builder.build(...).run(...) ExitRequested handler and managed ExitGate, the confirm_exit command registration, and SaveStatus mounted once at the application root. Phase 2 may install Tauri's native predefined Quit menu normally: it must pass through ExitRequested. Custom Quit actions should call app.exit(0) or emit request-safe-exit; they must not destroy the window, call process::exit, or set the approval gate directly. Only successful flush or the user's explicit Quit anyway invokes confirm_exit. The intentionally Phase 2-connected Settings event and existing deleted-module queue drop() are unchanged.
