# Phase 4 / Phase 5 integration

Merged reviewed combined phases 1–4 commit
`5c542e0091b6cff448c55b10e4c0fb9f33b1a054` into Phase 5 at `7e4a4a8`
in the existing `t3/implement-image-occlusion` checkout. Both histories are
preserved. No checkout creation/switch/reset, other-worktree edits, delegates,
push, PR, or main merge. Supplied AGENTS rules and all existing integration/review
documents were read. No scoped on-disk AGENTS file was found. Test-audit was used;
its OpenClaw-specific scripts and autoreview skill are unavailable in this repo.

## Integration

- Retained all database migrations: flashcards, shared-image leases, search and
  AUTOINCREMENT update IDs. Image resolution now uses Db::lock's unavailable
  database gate, as do content, card, search and backup IPC commands.
- Kept retain_module before history deletion and after snapshot replacement in
  compact_content's transaction. Cleanup/source deletion retain the Phase 5
  lease scan, asset transfer and stored-face retention. The BEFORE-apply-update
  deletion-range check and missing-update checks are unchanged.
- Occlusion attributes continue through the same editor Yjs update listener and
  save queue as text. Modal Save rejects suspended/destroyed/noneditable editor
  writes. Crop checks those conditions before work and after upload; uploads
  check queue suspension before reading and immediately before IPC. Compaction
  checks suspension in its timer and mutation admission too. Existing QueryClient
  upload/compaction mutations participate in restore's drain.
- Preserved Phase 4 card write admission, serialized full-snapshot sync, conflict
  repair, review mutation drain, async navigation blocker, and pre-review flush.
  Extraction still combines text and inline/block occlusion in one snapshot;
  face-pair validation remains fail-closed before displaying the image.
- Retained receipt reconciliation, restored-schema/index reload through open_db,
  safe-exit registration and ExitRequested handler, wait-for-restore barrier,
  native menu/history routing, palette/shortcuts, Settings and Review routes.

## Validation

- pnpm test: 60 passing.
- pnpm build: TypeScript/Vite passing, existing large-chunk warning.
- cargo test: 35 passing, binary/doc targets passing with zero cases.
- cargo clippy --all-targets -- -D warnings: passing.
- cargo fmt --check: passing.
- pnpm tauri build --debug --no-bundle: passing native debug application build.
- Staged and unstaged git diff --check: passing.

Three incoming compaction tests used arbitrary invalid Yjs blobs. They now use
valid Yrs/Yjs state and updates so they reach their intended atomicity and
watermark boundary. The rollback assertion explicitly requires the injected
'disk full' failure rather than allowing the decoder to fail first.

The new temporary-directory regression uses the real backup, restore, compaction
and deletion owners. It compacts away a foreign image, backs up its durable lease
and occlusion faces/due/repetition fields, removes live state/pixels, restores,
and checks exact card state. It then removes cards so stored faces cannot hide a
missing lease, deletes the uploader, checks pixels and transferred ownership,
and deletes the final lessee to check reclamation. Existing tests did not cross
this backup/reopen boundary. No production test-only seam was added. A negative
control temporarily omitted shared_image_refs from the backup SQLite file: the
new test failed when deleting the uploader removed the shared pixels. Restoring
production code passes.

## Risks and remaining independent verification

The conservative out-of-order history policy is intentionally unchanged. An
unrelated malformed or reordered persisted note can block cleanup and source
module deletion because they scan every note; that note's compaction also fails
closed. This can retain disk space and stall history maintenance. Relaxing it
requires a separately reviewed history/lease recovery design, not dropping the
guard in integration. Scans remain synchronous under the database lock.

No native GUI was launched and no real user data was opened. There is no runtime
disposable-profile override that also isolates the hardcoded legacy import
source; changing only the bundle identifier would still inspect that source.
Native GUI QA remains a gap: mask authoring/undo/crop/copy, menu/focus/shortcuts,
review rendering, quit during pending writes/restore, and native modal scheduling.
No browser preview or simulator was used. Existing power-loss fsync and OS-level
reopen/maintenance fault-injection limits remain. Independent review is pending.
