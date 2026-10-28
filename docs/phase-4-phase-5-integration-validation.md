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

## Final lifecycle blockers (follow-up to fb6fd8e)

The deletion owner now enters `exclusiveWrite` before invoking `delete_module`.
It closes editor/image admission synchronously, waits for complete admitted image
operations, flushes card snapshots and every note's Yjs queue, then suspends the
queue and drains other QueryClient mutations before the native shared-reference
scan. Deletion retains admission through navigation/cache removal. A failed
foreign-note save prevents IPC deletion, leaves its queued bytes intact and
reopens editing; the module dialog displays the error and remains open.

Normal quit uses the same barrier. `imageOperation` tracks the full paste/drop/
file-picker and crop continuation, including insertion, rather than only the
`upload-file` mutation. Once insertion emits its synchronous Yjs update, the
subsequent global save drain waits for that receipt. Admission rejects reentrant
image/crop/picker callbacks. Upload retains its pre-read and post-read suspension
checks; insertion/crop recheck suspension and editor destruction after upload,
and crop also checks after reading. Already-admitted operations may finish while
editors are temporarily read-only, because the exclusive owner waits before
suspending persistence. Failed insertion commands now reject the operation.
Native undo/redo rejects a read-only editor; the pinned history implementation
and dependency patch are preserved.

Restore, delete and quit share one exclusive owner and reject overlaps. Only that
owner can suspend/resume the queue. Failures resume its suspension and reopen
editor admission; restore success retains both until reload, and exit success
retains them until termination. Quit still waits for the restore mutation,
including its success/rollback callbacks. The quit failure dialog offers retry,
keep editing and explicit discard. Discard skips saving but still waits for full
image continuations and all other native write mutations before confirming exit.

Three new tests own these shared lifecycle contracts, using real QueryClient
mutations, Yjs documents, the production save queue and mocked Tauri IPC:

- Foreign image reference in B fails/backoffs, deletion of A is denied without
  dropping B, then retry persists the reference before deletion's IPC scan.
  The deletion itself is a QueryClient mutation, checking self-drain exclusion.
- Deferred upload completes its mutation while its insertion continuation is
  still waiting; quit waits for that continuation and its deferred Yjs receipt.
  New image/exclusive admission is rejected while the owner is active.
- Failed image continuation prevents normal exit; explicit discard still waits
  for an outstanding native mutation and rejects overlapping exclusive work.

These protect observable ordering missing from the previous 60 tests. No
production test-only seam was added. Negative controls bypassing the global save
drain and the full image-operation drain each failed with the expected missing
persisted image reference. Both controls were removed. Full validation: 63 JS
and 35 Rust tests passing; TypeScript/Vite, Rust formatting, strict Clippy
`--all-targets -- -D warnings`, native `tauri build --debug --no-bundle`, and
`git diff --check` passing. The existing Vite chunk-size warning remains.
Rust fixtures use temporary directories; frontend tests use in-memory documents
and mocked IPC. No application was launched and no real user notes were read.
The test-audit authoring gate was applied; its OpenClaw scripts/autoreview are
not available in this repository. Production changes were reviewed directly.

Native GUI verification remains open: WebKit/native file-picker callback timing,
read-only editor behavior while a modal is pending, actual pasted/copied shared
image deletion, crop/undo interactions, quit retry/discard during upload or
restore, native menu/focus routing and relaunch. The deferred tests prove the
JavaScript lifecycle ordering, not native dialog scheduling or OS termination.
No simulator or browser was used. Existing disk durability/power-loss gaps from
the preceding integration remain unchanged.
