# Large imported note performance

Measured on this Mac on 2026-11-06 in Playwright WebKit with the real noteExtensions,
Yjs collaboration, production CSS and React TextBubbleMenu. No simulator was used.
The benchmark reads the optional local folder; it never calls import_module or writes
app data. Asset reads are served locally. All save-queue receipts are in memory.
No course content is included in this repository.

Run from apps/shared-ui:

```sh
node --experimental-strip-types --test tests/large-note.test.mjs
LARGE_NOTE_FOLDER='/Users/vladyslavnalyvaiko/Downloads/COMP0002 - Principles of Programming/01 Lecture Notes' node --experimental-strip-types --test tests/large-note.test.mjs
```

The real-folder benchmark skips when the folder is absent. The synthetic outline
regression still runs. Temporary Vite caches and disabled HMR isolate browser tests
from concurrent checkout edits. The fixture normalizes the import and reopens a
fresh Yjs snapshot, with heading numbers enabled. Each action has 25 samples at
50% and 98% of the eligible paragraph positions. Scrolling alternates 100px in both
directions; positions at the document boundary may still clamp. Opening has five
samples. Keydown capture to the first animation frame followed by a task is a
paint-opportunity proxy, not hardware display latency. This is a warm development
harness, not a cold launch or production native IPC/disk benchmark. Reported WebKit
times have millisecond precision. Run timing samples alone, not during the full suite.
The lecture runs predate the alternating-scroll harness refinement; their scroll
numbers should not be compared with the full-folder scroll numbers.

Target: typing p95 around 16-30ms on this Mac. The final run meets that target;
other shared-machine runs ranged from 18-30ms p95. Do not impose a noisy wall-clock
threshold in CI. Weaker iPads need separate hardware measurements.

## Measurements

Full import: 7,143 descendants, 127,210 text characters (excluding nontext assets).
Values below are p50 / p95 milliseconds. Full machine-readable results and plugin
samples are in large-note-results.json. Before uses the upstream synchronous TOC;
after changes only its transaction refresh scheduling.

| Action | Before | After |
| --- | --- | --- |
| middle typing | 26 / 34 | 17 / 21 |
| middle Enter | 32 / 36 | 24 / 27 |
| middle selection | 13 / 16 | 14 / 24 |
| middle scroll | 15 / 16 | 14 / 16 |
| end typing | 26 / 31 | 19 / 29 |
| end Enter | 34 / 40 | 28 / 32 |
| end selection | 14 / 20 | 13 / 26 |
| end scroll | 15 / 30 | 16 / 17 |
| Opening | 684 / 727 | 275 / 801 |

Lecture-only import: 3,634 descendants, 66,872 text characters. Middle typing
15/16ms before and 15/16ms after; end typing 15/16ms before and 14/15ms after.
Opening 367/613ms before and 271/469ms after. It was already near the frame floor.

## Cause and change

The upstream TOC onTransaction rebuilt all headings, read offsetTop for them,
recomputed active states, and dispatched another editor transaction on every edit.
On the full import its callback p95 was 13ms before and 2ms after; total measured
callback time fell from 1,253ms / 288 calls to 206ms / 192 calls. The different call
counts include the upstream extra transaction. These are inclusive callback
measurements, not additive exclusive CPU samples.

note-extensions.ts now coalesces visual outline refreshes until 100ms after edits
settle. The upstream appendTransaction still assigns and repairs heading IDs
synchronously. Existing outline positions and nodes are mapped immediately and
published to consumers, so navigation remains valid during the delay. The timer
is cancelled on destruction. No document writes, undo, card IDs, saving or quit
flush paths were deferred or changed. Tests exercise positions, folding, numbering,
undo, persisted Yjs content and teardown with an outstanding refresh.

## Other suspects and remaining limits

- Heading-number decorations are now the largest instrumented plugin cost at
  about 2ms p95. They rebuild even on selections; this is a plausible later cache
  optimization, but small relative to the original TOC cost. No second change was
  justified by these measurements.
- Heading-fold apply is about 2ms p95; its layout signature and decoration mapping
  already avoid remounting unchanged toggles. Hierarchy append, flashcard IDs,
  flashcard decorations, find state and inline-math decorations were 0-1ms p95.
  Section-focus is effectively empty while unfocused; sections has no per-edit
  plugin. Focused sections, active find queries and card-heavy imports need their
  own workloads; this course fixture cannot establish all their worst cases.
- The math index already diffs immutable documents and scans changed neighborhoods.
  Inline/block formula rendering uses the shared viewport renderer and retains
  mounted previews. Images and node-view updates are included in paint latency,
  but not separately attributed by this callback profiler. There is no syntax
  highlighting extension in noteExtensions (StarterKit uses plain code blocks).
- The actual React bubble menu is mounted. Its selectors run on transactions;
  full-app Tiptap already sets shouldRerenderOnTransaction:false. The benchmark
  does not mount the TOC panel, which is being optimized separately.
- Card sync already waits 800ms, search indexing 1,000ms; both have explicit flush
  paths. Baseline standalone extraction p95 was 2ms for cards and 3ms for search.
  Subsequent idle samples show scheduling outliers (search 26ms p95), so they
  should stay outside the input critical path.
- The production save queue with throwaway receipts took 0/1ms p50/p95 for a
  102-byte incremental Yjs update. Tiptap persists incremental update events,
  not full snapshots per key. Full Yjs snapshot encoding was 3/4ms before and
  4/17ms after (idle samples with scheduling noise); compaction is already idle
  and guarded against pending writes. Native database time is unmeasured.
- CSS currently has no content-visibility optimization. Adding it blindly risks
  caret, selection, find rectangles and TOC offset calculations. The remaining
  Enter near the end (32ms p95) includes ProseMirror/Yjs work and WebKit layout of
  the large live DOM. Opening still mounts thousands of nodes and can approach
  0.8s p95; five samples do not establish an opening p95 improvement.
- iPad runs the same extension configuration, so it gets this fix. Its native
  editor-host also publishes an outline and current-section layout to the host;
  that separate path and slower hardware were not profiled here. No simulator
  was driven. Avoid treating these desktop numbers as an iPad guarantee.

Splitting very large imports into several modules remains advisable, particularly
on iPad: it reduces initial DOM size, opening time, layout, indexing and snapshot
cost, even after removing synchronous TOC work from typing.

## Validation

Final pnpm lint and pnpm build pass (build emits its existing large-chunk warning).
Final pnpm test passes all 254 tests, including the new real-folder benchmark and
synthetic outline regression. Earlier runs during concurrent checkout changes
failed on TOC-panel TypeScript errors and browser reloads; those errors were
resolved by the owning agent, and these two harnesses now disable HMR.
