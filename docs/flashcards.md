# Flashcards: text and image occlusion

Cards are authored as editable note text. ProseMirror decorations style syntax;
paragraph and heading `cardId` attributes are persisted in Yjs. Math blocks do
not create cards. Cards are indexed when a module is opened, after 800 ms of
idle editing, and on editor cleanup. All in-app navigation flushes pending writes
before leaving the editor, including cross-module copy conflict repairs.
Existing modules must be opened once to index their cards; there is no background
scan of unopened Yjs documents. Review displays the unindexed notes with Open
buttons and does not claim the whole library is caught up until they are checked.
The card_indexed_modules table tracks successful complete syncs, including empty
notes; unresolved cross-module conflicts leave a note marked incomplete.

## Syntax and identity

- Basic: `Question :: Answer`. The first `::` with no adjacent non-whitespace
  text character splits the block. Thus `a::b` and `x ::: y` stay prose. A math
  node or hard break can border the separator. Both sides are trimmed and must
  contain non-whitespace text or inline math. Later `::` is answer content.
- Cloze: `{{hidden}}`. Each non-empty closed cloze produces a separate card;
  its front shows the entire block with that cloze replaced by `[…]`. Other
  clozes are visible without braces. The back highlights the revealed answer.
  A block containing only `{{answer}}` is valid; its front is the blank.
- Valid clozes take precedence over basic syntax: `::` remains literal text in
  that block. If no valid cloze exists, basic parsing still applies.
- Clozes do not nest: the last opening `{{` before a closing `}}` wins. Empty,
  whitespace-only, unmatched, or inline-code delimiters are ignored as syntax.
- Syntax can cross text mark boundaries. Bold, italic, underline, strike, code,
  and highlight content survives extraction; links are rendered as plain text.
  Inline math becomes a KaTeX segment. Inline images/other atoms are omitted.
- “Make card” wraps a non-empty selection within one paragraph or heading in
  `{{…}}`, leaving surrounding whitespace outside. It supports undo.
- Basic ids are the block UUID; cloze ids are `<block UUID>:c1`, `:c2`, etc.,
  in document order. Text edits preserve block identity; syntax removal soft
  deletes cards, and undo/retyping restores them. Paste duplicates get fresh ids.
  Cross-module copies receive new ids if the source card is still live; a card
  soft-deleted in the source can move to the destination with its history.
- Cloze identity is positional within the block: inserting/removing/reordering
  clozes can reassign which answer owns an existing cloze's schedule. This is
  a known limitation of the requested `:c<n>` identity design.

## Scheduling and storage

`pnpm view ts-fsrs version` returned **6.0.0** on 2026-10-28; this is also the
installed/locked version. The app explicitly selects **FSRS-7**, with the
library's fixed default parameters and no settings UI. Library and algorithm
versions are independent (https://github.com/open-spaced-repetition/ts-fsrs).
The scheduler is TypeScript-only; Rust stores its plain JSON-compatible results.
Elapsed days are derived from review timestamps rather than stored redundantly.
FSRS-7 also requires `stability_fast` and fractional `scheduled_days`.

`migrate_flashcards` runs from `open_db`, creating:

- `cards`: `id` primary key; `module_id` foreign key; extensible `kind`; JSON
  `front` and `back`; `due_at`, `stability`, `stability_fast`, `difficulty`,
  `scheduled_days`, `learning_step`, `reps`, `lapses`, `state`, `schedule_status`,
  `last_review_at`, `fsrs_model`; `created_at`, `updated_at`, `deleted_at`.
- `review_log`: integer primary key, `card_id`, rating, review timestamp,
  duration, FSRS model name, and pre-review due/last-review timestamps,
  stability/fast stability/difficulty, scheduled days, learning step, state,
  and schedule status. Card and log writes share a transaction.
- Module, live-due, and card/review-time indexes. Module deletion cascades to
  cards and review logs. All timestamps crossing IPC are epoch milliseconds.

IPC contracts (camelCase arguments):

- `sync_cards({ moduleId, cards: [{ id, kind, front, back }] }) -> string[]`:
  complete module snapshot. Upsert changes content without resetting scheduling;
  missing ids are soft-deleted, returning ids are restored. Returns ids owned by
  another live module, which the editor renews before resyncing.
- `due_cards({ moduleId: string | null, now })`: live cards due at/before `now`,
  sorted by due time and id, including module id/name and FSRS fields.
- `due_counts({ now })`: `{ moduleId, count }[]`, excluding soft-deleted cards.
- `review_card({ cardId, expectedReps, card, log })`: persist `scheduleReview`
  output atomically. Reject missing/deleted cards and stale repetition counts.

`/review?module=<id>` limits scope; `/review` reviews all indexed modules.
Space reveals; 1–4 grade Again/Hard/Good/Easy; Escape closes. Buttons preview
FSRS intervals. The session begins with a due snapshot and requeues learning
steps within 20 minutes, showing them early when nothing older remains. Other
newly due cards require another session. Counts refresh every minute and after
sync, review, and module deletion. Persistence errors retain the current card
for retry; stale review errors require leaving and reopening the session.

## Phase 5 image occlusion integration contract

Storage already accepts `kind: "occlusion"` and arbitrary JSON `front`/`back`.
No scheduling or database schema change is needed for mask geometry. The current
TypeScript faces are `Segment[]`; Phase 5 must widen them to a discriminated
payload union and implement the `occlusion` branch in `CardFace`.

Use stable **image UUID + mask UUID** identities, for example
`<image UUID>:o:<mask UUID>`, with one card per mask. Persist these ids and mask
geometry in the Yjs image node, not only React state. Reordering or editing a
mask must preserve its id. Copying an image must renew image/mask identities.
Extend `blockIdOf`/conflict repair for these ids; it currently strips only `:cN`.

Recommended versioned payload for both faces:

```ts
type OcclusionFace = {
  version: 1;
  fileId: string; // resolve the existing saved-image file, not a transient URL
  imageId: string;
  targetMaskId: string;
  revealed: boolean;
  masks: Array<
    | { id: string; shape: "rectangle"; x: number; y: number; width: number; height: number }
    | { id: string; shape: "ellipse"; cx: number; cy: number; rx: number; ry: number }
    | { id: string; shape: "freehand"; points: Array<{ x: number; y: number }> }
  >;
};
```

Coordinates should be normalized to intrinsic image dimensions (0–1), so
resizing the note or review viewport preserves alignment. Close freehand paths.
Define whether non-target masks remain visible; front/back must share the same
geometry and differ only in the target reveal policy.

Extend `extractCards` to traverse image nodes and return the **union** of text
and occlusion cards in the same `sync_cards` snapshot. Separate partial syncs
would soft-delete each other's cards. Removing a mask/image should omit its card;
undo must restore the same id and schedule. Resolve assets through the existing
saved-image/Tauri asset protocol and coordinate cleanup with file references;
review faces must tolerate an unavailable/deleted image. Existing due queries,
review transaction, queue, and FSRS state remain shared across kinds.

## Validation and manual checklist

Automated validation: `pnpm build`, `pnpm test` (31 tests), `cargo test` (11 tests),
`cargo clippy`, and `git diff --check`. Clippy reports an existing redundant field
initialization at `src-tauri/src/lib.rs:667`; Vite warns about large chunks.
The new editor tests exercise actual Tiptap commands/plugins without mounting a
DOM; extraction, scheduling previews, sync storage, restoration, stale review
rejection, and cascade deletion also have automated coverage.

No GUI was run. Manually verify macOS WebKit caret/selection around decorations,
bubble selection with inline math, typing/undo/copy across modules, immediately
opening review after an edit, due counts after deletion, reopen persistence,
keyboard/button focus, KaTeX rendering, full-screen chrome, and the done/error
states. Test first-time indexing by opening an older module. No push or PR.


## Phase 5 implemented policy

Saved-image controls include **Occlusion** for saved block and inline images.
A native modal dialog traps focus and supports Escape/Cancel. Choose rectangle,
ellipse or freehand, then drag over the image. Freehand paths are closed polygons.
Select a mask by clicking it with Select or by its numbered button. Rectangle and
ellipse fields edit normalized coordinates; freehand points are editable JSON.
The keyboard Add button creates a centered mask of the chosen shape. Delete and
local Undo operate on the draft; Cancel discards the whole draft. Save writes one
image-node attribute transaction, which the note's existing Yjs undo can restore.
There is no separate scheduling or mask state outside the note.

Each mask produces `<image UUID>:o:<mask UUID>`. Both card faces carry the same
version-1 geometry. The front fills **only the target** in opaque blue; other
answers are visible. The back removes that fill and outlines the target in gold.
No policy toggle is offered. Coordinates use the actual displayed image bounds,
normalized to 0–1; viewport/note resizing does not change geometry. Degenerate,
non-finite and out-of-bounds masks are ignored rather than creating broken cards.
Freehand paths are limited to 4096 points. Editing and reordering preserve ids;
paste renews image and mask UUIDs, including copies between modules. Layout
changes between inline/block retain ids. Image cards join text cards in the
existing single complete module snapshot and use the same fixed FSRS-7 defaults,
module/global review queues, and atomic review logs. Math behavior is unchanged.

Crop is the existing asset-replacement operation: entering crop with masks
requires an explicit reset confirmation. Applying it writes the new asset and
clears masks together, retiring cards; note Undo restores the old asset, masks,
ids and schedules. Opening/cancelling crop does not clear anything. No general
image replacement action is exposed. Future replacement actions must also reset
with confirmation or transform geometry; they must not reuse unchanged masks on
unrelated pixels.

Review resolves the managed file id through Tauri and the asset protocol, rather
than saving URLs in cards. Copies share the managed asset. Before cleanup or
module deletion, Rust replays **all persisted notes**, including unopened notes,
with Yrs (Yjs v1 updates), and records foreign `fileId` references in the durable
`shared_image_refs` table. This covers ordinary block/inline images before masks
or card indexing, nested nodes, and incremental saved updates. The database lock
serializes the scan and deletion against saves. Existing owner-snapshot revision
checks still reject stale cleanup requests. Compaction records leases from every
persisted intermediate revision before discarding updates, in the same transaction
as snapshot replacement, and checks the replacement before committing.

A foreign-note lease lasts until that note is deleted, including after image
removal, crop, undo/redo, restart and compaction. Cleanup also retains **any stored
occlusion face, including soft-deleted cards**, as before. These conservative
policies preserve recoverable history and may retain unused disk space; no history
asset garbage collector is included. Deleting the uploading note transfers shared
assets to a surviving referencing note instead of breaking destination copies or
retiring their cards. Repeated owner deletion transfers again, and deleting the
last referencing note removes its managed files. Unshared unused uploads still
use normal startup cleanup. Invalid or incomplete persisted Yjs notes prevent
cleanup and module deletion until repaired, rather than guessing which files are
safe. Missing physical files still display as unavailable.

Limitations: scans replay note histories under the database lock and may delay
writes in a large library. Only successfully persisted content can establish a
reference; navigation must flush pending saves as before. References already
removed and compacted before this migration cannot be reconstructed, and already
deleted image bytes cannot be recovered. New leases protect future compaction.

Phase 5 verification uses only synthetic editor documents and temporary SQLite
fixtures. `pnpm build`, `pnpm test` (38 tests), `cargo test` (14 tests),
`cargo clippy --all-targets`, and `git diff --check` are the validation commands.
Native GUI QA has **not** been run; no browser preview was used.

Manual macOS QA before release:

- Draw each shape at several image sizes; resize the note/review and confirm
  target alignment, front concealment, back outline, and other visible answers.
- Use Tab/Shift-Tab, Escape, labeled numeric fields, freehand point editing,
  keyboard Add, selection, Delete, draft Undo, Cancel, Save and note Undo/Redo.
- Reopen a note and app; verify masks persist in Yjs. Edit/reorder/delete masks
  after grading and verify schedules survive edit and delete/undo.
- Copy through the native clipboard within/across modules, including inline
  images and text-card paragraphs; verify fresh ids and independent schedules.
- Switch image layout and theme, cancel a crop/reset confirmation, apply a crop,
  then undo it. Confirm no silent geometry misalignment or unexpected retirement.
- Exercise module/global review, immediate review after save, unavailable image
  UI, cleanup after relaunch, and deletion of a source module with copied masks.
  Verify destination copies and their cards remain available, and deleting the
  final referencing note reclaims the shared file.

Export and AI remain out of scope. No push or PR is part of this phase handoff.
