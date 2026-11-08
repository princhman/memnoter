# Shared UI special-case sweep

Baseline: `a6a71ea43f081378c6e4e697013a88701ed32584`. Scope: production TypeScript/TSX under `apps/shared-ui/src`; native code and unrelated comments are unchanged. Test support migrates the import-dialog fixture to the new component API and accepts native or ARIA dialog semantics. The obsolete timeout-bypass restore case is removed; existing deferred-worker tests still enforce waiting for both real completions.

## Counts

| Category | Before | After |
| --- | ---: | ---: |
| `setTimeout` / `requestAnimationFrame` call sites | 52 | 35 |
| Syntactically empty catches / rejection callbacks | 9 | 0 |
| Platform expressions/references (excluding imports of detector functions) | 45 | 28 |
| Platform expressions outside host/platform/shortcut adapters | 32 | 0 |
| Scroll-container selector lookups (literal or named constant) | 14 | 1 |
| Targeted one-caller parameters (`hostOnly`, create `global`, two flush `timeoutMs` parameters) | 4 | 0 |
| Encoded find state keys | 1 | 0 |
| Native history subscription implementations | 2 | 1 |
| Image modal implementations | 3 | 1 |

The timer metric matches `\b(?:setTimeout|requestAnimationFrame)\s*\(`, including the save queue's injected timer call and its implementation. Type annotations are excluded. Platform expressions match `\b(?:isTauri|isNativeHost)\s*\(|\b(?:IS_IOS|IS_MAC|IS_APPLE|MOD_KEY)\b`; this deliberately includes detector declarations and constant imports/references, so it is a reproducible textual inventory rather than a count of `if` statements. Boundaries are `lib/{backend,platform,editor-host,shortcuts}.ts`. Empty-catch counts exclude comments; the original menu rejection callback also had a comment-only body, and now reports errors.

## Requirements given an owner

- **Editor host:** one host contract/context provides native presentation, scroll-container resolution, and focus policy. The CSS class is resolved in one place. Plugins use the non-React contract; React UI uses the context. TOC receives its own mounted scroll parent, never a global document query. The native host does not render a dead desktop TOC. Native editor DOM marker reads and `hostOnly` are gone.
- **Navigation:** explicit navigation subscriptions stop persisted scroll restoration. Section anchors observe actual asset/layout completion and release after stable paint frames, input, replacement, or teardown, instead of expiring after 300 ms. Saved scroll restoration observes layout until navigation, reader input, or teardown rather than expiring after three seconds.
- **Completion:** save/flush and sync-stop await the work they promise to drain. Headless card indexing awaits collaboration's first-render callback. Import normalization is synchronous. TOC uses the upstream transaction lifecycle instead of a separate 100 ms refresh timer.
- **Focus/modal lifecycle:** find fields and TOC popup focus follow React commit; link fields focus on mount without scrolling; palette commands follow the dialog close-complete callback. Image crop, preview, and masks share the dialog primitive and its host focus policy. Image gesture thresholds have one definition.
- **Host capabilities:** update, folder import, version, window chrome, app exit, history, native menus, view-state transport, and external links have their host differences in backend/platform adapters. The unused modifier compatibility export is gone.
- **Commands/history:** one persistent module-creation dialog owns creation commands and import registration. Sidebar buttons request it. Review entry prepares through routing; it no longer pre-flushes again in `openReview`. One native-history hook owns menu/focus subscriptions and unmount cleanup. Route matching supplies note identity without static-route exclusions.
- **Notifications:** successful card writes announce changes directly. Native notification no longer retains a dummy query or uses startup/debounce timers. Remote review/module updates announce through the same channel.
- **Failures:** recoverable DOM/state failures log context. Serialized queue barriers use one explicit `settled` helper; their rejecting operation remains with the caller and/or existing logging. Cleanup observes settlement without creating and swallowing another rejected promise. Corrupt sync account JSON already propagates to the logged startup error state and remains so.

## Timers and fallbacks retained

- Save queue debounce/retry, editor card/search batching, view/state persistence, compaction idle delay, palette search, sync push batching, remote derived-index batching, file request coalescing/retry, and reconnect backoff avoid doing expensive work per keystroke/network frame.
- Review due times and midnight timers represent actual clock deadlines. HTTP abort is a real transport deadline. Update minimum spinner time and status expiry, TOC hover/close grace, and LaTeX pointer-aim delay are deliberate interaction durations.
- Import task yielding and idle-backfill fallback preserve responsiveness. Image-cache trimming crosses the DOM unmount task boundary before checking whether URLs are displayed. Composition-end crosses ProseMirror's own browser-event task boundary; removing it would paint selection highlights during composition cleanup.
- Frames paint drag autoscroll, find highlights, viewport-mounted formulas, native caret/inset correction, and stable section-anchor layout. These operate on rendered geometry, not pending application writes.
- Microtasks used to avoid dispatching recursively during ProseMirror/Yjs initialization, bracket native drop history, and unmount React node-view roots remain. They cross documented synchronous framework stacks rather than pretending to await persistence.
- Malformed user-input regex/HTML/math/image parsing keeps its explicit fallback. Literal malformed percent escapes in imported paths remain literal. These catches produce an intentional alternative result; they are not empty error handlers.
- `isModuleOpen` retains its mounted-editor ownership registry: background indexing must defer even before a routed note is ready, and the native host has no router. `useOpenModuleId`/`isShowingModule` instead own routed presentation identity.

## Test migrations

- `tests/browser/import-dialog.tsx`: mounts the sidebar trigger and persistent dialog through their explicit components. Existing import behavior tests remain intact.
- `tests/module-actions.test.mjs`: checks that a tooltip is contained by a semantic dialog, accepting either HTML dialog or ARIA dialog. Its observable tooltip/focus contract is unchanged.
- `tests/restore.test.mjs`: removes only the stalled-drain timeout-bypass variant and its fake-clock coordination. `restore drains sync and restarts against resulting database on success/failure` already holds both worker promises and checks that restore does not run until both complete; rejected-worker restart coverage remains. The retired variant required the data swap to overtake unresolved work, contrary to the requested completion contract.

## Validation

- `pnpm check`: passed (lint, TypeScript/Vite production build, 278 shared-ui tests, 21 sync-worker tests, Rust workspace tests).
- Second full `pnpm test`: 278 passed, 0 failed/cancelled/skipped.
- Focused WK host suite: 6 passed, including teardown, card-info taps, native typing and section anchoring.
- Focused TOC suite: 15 passed; import-dialog suite: 8 passed; module-actions/restore suites: 9 passed.
- `git diff --check`: passed.

Initial validation caught and repaired the destroyed-editor TOC lookup, existing-popup keyboard focus, premature/indefinite anchor release, and ResizeObserver mutation ordering. Three test/support files required the API/contract migrations described above. Final full runs use the settled production code.
