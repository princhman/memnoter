# Phase 3 / Phase 4 integration

Merged local Phase 3 ae6fd2ca815bafe11cfff5c477a54b29dca04a8d (including
55177ee quit/restore barrier) into reviewed Phase 4 0cf5b00 in its existing
checkout. Both histories remain. No checkout switch/create/reset, other worktree
edit, Phase 5 change, push, PR, or main merge. Phase 3 independent review remains
external to this integration.

Read supplied AGENTS rules, README, flashcards documentation and incoming Phase
1/2/3 review/integration documents. No on-disk scoped AGENTS was found. Test-audit
was applied to the new lifecycle test; OpenClaw-specific tools are absent here.

## Integration decisions

- Resolved Rust module/migration/invoke conflicts by retaining cards, search,
  backups, native menu history, and safe-exit registrations. All five card IPC
  commands use Db::lock, including the unavailable database guard.
- Card sync and review register real QueryClient mutations synchronously before
  their IPC. Restore's existing mutation drain now includes them. Suspension
  rejects new writes, including queued syncs reaching admission after suspension.
  Sync cleanup does not write during suspension or loop on an unsent snapshot.
- Backup and restore flush cards before note saves, so copied-card identity
  repairs are saved too. Normal quit flushes cards and notes, then suspends write
  admission and drains card writes before confirm_exit. Explicit quit anyway
  also suspends/drains cards and retains the existing restore-settlement barrier.
- Registered global and module Review palette commands through shared flush and
  visible error handling. Existing review route beforeLoad flush and async
  navigation blocker remain, as does the pinned TanStack history delta patch.
- Merged bubble menu card and link/math actions, Sidebar Review and Settings,
  full-screen Review and root SaveStatus/backup handling. Regenerated routeTree
  with the existing Vite plugin, retaining Settings and Review.
- Preserved Phase 3 content receipt publication, compaction checkpoints, native
  history/focus routing, Cmd+K/Cmd+L/Find paths; Phase 4 incomplete-index UI,
  math exclusion, card identities and fixed FSRS defaults remain unchanged.

## Validation

- pnpm test: 56 passing.
- pnpm build: passing TypeScript and Vite; existing large chunk warning.
- cargo test --manifest-path src-tauri/Cargo.toml: 28 passing, binary/doc targets
  also pass with zero cases.
- cargo build --manifest-path src-tauri/Cargo.toml: passing.
- cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings:
  passing.
- cargo fmt --manifest-path src-tauri/Cargo.toml --check: passing.
- New card-writes test exercises real QueryClient/saveQueue owners and mocked
  IPC: immediate drain visibility of sync/review, rejected suspended admission,
  drain waiting for the final outstanding review, and propagated storage errors.
  Existing coverage did not cross this lifecycle boundary. No test-only seam.
  Negative control bypassing mutation registration fails with zero active writes
  versus two; restored production code passes.

## Remaining verification

No native app was launched, no real user data opened, and no simulator used.
Native AppKit/WKWebView menu, focus, keyboard, review UI, and quit/restore dialog
scheduling remain manual verification gaps. This is compilation and automated
owner-boundary proof, not native GUI proof. Incoming review findings may require
follow-up. Existing crash-recovery fsync and OS failure-injection limits remain.
Phase 5 asset repair and the later Phase 4 -> Phase 5 merge belong to the parent.
