# Phase 4 flashcards

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
