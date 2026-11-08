# Untangle audit: Memnoter, 2026-11-08

Branch `feat/tables-highlights-import`, working tree including uncommitted changes. Read-only audit: nothing in the code was changed.

The question asked of every part of the codebase: **should these pieces change together?** The answers fall into hidden links, needless links, surplus and special cases. The report also covers comments and tests.

## At a glance

| Measure | Now |
|---|---|
| Source size | ~41k lines: Rust core, Tauri desktop, UniFFI, React/TipTap UI, SwiftUI, CF worker |
| Biggest change magnets (git) | `Tiptap.tsx` 45, desktop `lib.rs` 45, `App.css` 38, `RootView.swift` 34, `WebHost.swift` 24 |
| Top co-change pairs | `App.css`↔`Tiptap.tsx` 16, `RootView`↔`WebHost` 13, `Tiptap.tsx`↔desktop `lib.rs` 12 |
| Upward imports (lib → components) | `note-extensions.ts`, `inline-math.tsx`, `review-actions.ts`; `ui/sidebar` → `lib/app-events`; `ui/dialog`, `ui/sheet` → `icon-tooltip` |
| Special cases (rough count) | 55 timers used for synchronization (setTimeout/rAF/asyncAfter), 44 platform checks, ~45 places that swallow errors (TS `catch{}`, Swift `try?`, Rust `let _ =`) |
| Logic implemented twice across languages | sync engine (TS + Swift), review session (TS + Swift), key-check crypto (Rust + TS + Swift), card-id grammar (TS + SQL) |
| Tests | 272 in shared-ui: 1st run 5 failures (flaky or stale expectation, no product bug), 2nd run all green. 5 tests never run off this machine |

**The pattern in one sentence.** Most of the coupling comes from contracts that live in people's heads instead of in code:
- the command list,
- the outbox signal,
- the sync wire protocol,
- the native JS bridge,
- the card-id grammar,
- the shortcut table,
- the scroll-container class.

Each one is copied into 2–6 places, across up to 3 languages. Most of the fixes below give each contract a single owner and *derive* every other copy from it.

---

## Root-cause fixes, ranked by leverage

Each fix is listed above the problems it solves.

### 1. Commands are defined once in `memnoter-core`. Desktop, iOS and TS types are derived from that definition.

**Fix:**
- Desktop exposes a single `core(command, args)` Tauri command that forwards to `memnoter_core::dispatch`. Only the commands that belong to the desktop shell itself stay in `apps/desktop`: exit, restart, menu and the folder picker.
- Generate the TS and Swift arg/result types from the `commands!` table (ts-rs/specta, or UniFFI records), with one key casing.

**Problems it solves:**
- **Pass-through wrappers.** `apps/desktop/src/lib.rs:28-179`, `cards.rs`, `sync.rs` and `backups.rs` contain 37 wrappers that repeat `crates/memnoter-core/src/dispatch.rs:28-67` argument for argument. Desktop wrappers changed in 17 commits together with core cards.
- **Drift test.** `crates/memnoter-core/tests/dispatch.rs:30-62` runs `include_str!` on the desktop `lib.rs` and parses `generate_handler!` to catch drift. That means the core's test knows desktop shell command names, and the current diff already had to edit it for `read_import_images`.
- **A test that can't fail.** `tests/dispatch.rs:63-68` asserts that `DATA_COMMANDS` aren't "Unknown command", but both sides come from the same macro arm.
- **Inconsistent threading.** `create_module`, `modules`, `rename_module`, `set_module_numbering` and `resolve_card_image` are sync `#[tauri::command]`s, so they run on the main thread and take the DB lock. The core README says not to call storage from the UI thread.
- **Shapes declared three times.**
  - Rust structs.
  - Swift structs in `CoreClient.swift:4-125`.
  - TS annotations at each call site; `modules` is typed at 8 different TS call sites.
- **Mixed casing.** snake_case (`Module`, `SearchResult`, …) and camelCase (`Card`, `SyncStatus`, …) are mixed, as `crates/memnoter-core/README.md:26-27` admits.
- **Data dir and DB passed separately.** Core functions take `(data_dir, &db)` separately instead of `&Core`, only because the wrappers were written by hand.

### 2. The core announces outbox writes itself.

**Fix:**
- `push_outbox` marks the transaction. After commit, the core fires a single `OUTBOX_EVENT`: a UniFFI callback on iOS, the Tauri emit on desktop. Alternatively, `dispatch` returns `{value, outboxChanged}`.
- Remove the hand-kept lists, the polling and the sleeps.

**Problems it solves:**
- **Desktop guesses.** `app.emit("sync-outbox")` is hard-coded 10 times (`apps/desktop/src/lib.rs:43,55,70,80,98,119`, `cards.rs:46,67`, `sync.rs:17,68`), and every one discards its error with `let _ =`.
- **iOS guesses differently.** `apps/ios/Sources/CoreClient.swift:32` keeps its own 8-name list:
  - It nudges on `set_module_numbering`, which writes no outbox row.
  - It misses `import_module`, `restore_backup` and sync-apply deletions.
  - The `!hasPrefix("sync_")` check in that list does nothing.
- **Dead constant.** `crates/memnoter-core/src/sync.rs:50` defines `OUTBOX_EVENT`, and nothing uses it.
- **The signal is already computed, then dropped.** Every `record_*` returns "did I write to the outbox" (`sync.rs:126,144,185,214,261`), and every caller ignores it.
- **Polling and sleeps cover the gaps.**
  - `SyncClient.swift:233-244` runs a 15s ticker that does 3 core calls even when idle.
  - `RootView.swift:279-282` sleeps 3s as a stand-in for "push finished".
  - `ReviewView.swift:80-88` polls every 15s, and `MemnoterApp.swift:8-11` every 60s.
- **Fragile "cards changed" event.** `editor-host/main.tsx:17-37` detects card changes by watching React Query invalidations of `dueCountsKey`, kept alive with a fake disabled `useQuery`. It only works because 8 writers each remember to invalidate that key. `writeCards` should emit the event itself.

### 3. One sync engine. Native code only provides the transport.

**Fix:** move frame handling, push batching, drop dedup, blob refs, size limits and the key check into `crates/memnoter-core/src/sync/session.rs`. It is a pure state machine: a frame comes in, actions come out. Export it via UniFFI. Desktop uses it through dispatch and iOS through FFI. Swift keeps only URLSession, WebSocket and Keychain.

Until that lands, at minimum:
- Export `new_salt`, `make_key_check` and `verify_key_check` through FFI.
- Add `apps/sync/test/fixtures/protocol.json` with the frames, blob ref, close codes, limits and key-check vectors, asserted by Rust, the worker tests and TS.

**Problems it solves:**
- **Swift copies the TS engine.** `apps/ios/Sources/SyncClient.swift` is a hand-written port of `lib/sync/engine.ts`, `protocol.ts`, `crypto.ts` and `files.ts`, sharing none of their constants. It copies:
  - `"memnoter.v1"`/`"auth."` (`:262`), the 16 MiB frame limit (`:263`), `v: 1` (`:267`) and close code `4003` (`:211`);
  - the blob ref as raw `33`/`2` bytes, without the hex check (`:280,329`);
  - `1_900_000` (`:326`) and `1_048_576` (`:336`);
  - the 400 ms debounce (`:63`) and 30 s image retry (`:391`);
  - the `"key-check"`/`"memnoter-key-check"` strings and the 16-byte salt (`:172-180`), and the `"file:"+id` AAD (`:411,420`);
  - every `/v1/...` path.
- **The two engines already behave differently.**
  - Ping: iOS sends WebSocket control pings every 15s. TS sends text `"ping"` every 45s, and the worker only auto-answers the text ping (`vault.ts:59`). So iOS's `"pong"` check never fires, and whether control frames wake the hibernated object is unverified.
  - Backoff: iOS has no jitter.
  - Drops: iOS sends one drop per outbox row; TS sends one per doc.
  - Merging: iOS never merges updates.
  - Size: iOS skips the `MAX_LARGE_BLOB_BYTES` check.
  - Key derivation: iOS runs PBKDF2 at 600k iterations twice for a new account.
- **Fixes land in one engine only.** `36c7a05` (image-retry) and `8c07382` changed only the Swift client.
- **Crypto in three places.** The Rust crypto helpers (`sync/crypto.rs:23,64,68`) are used only by their own test; TS and Swift each reimplement them. The only cross-implementation test vector is in Rust, and there is no TS crypto test at all.
- **Close code 1008.** It appears 3 times with no shared constant: `SyncClient.swift:222`, `engine.ts:91` and `vault.ts:308`.
- **Server URL drift.** iOS hard-codes `https://sync.memnoter.com` (`SyncSettingsView.swift:5`), while TS honors `VITE_SYNC_SERVER`. The passphrase minimum of 10 is copied (`SyncSettingsView.swift:56` vs `sync-section.tsx:31`).
- **Stored account means different things.** The `sync_state.account` value is different per host, and `sync.rs:764-790` special-cases it:
  - Desktop stores the full account, including the raw AES key and token, in `main.db`. `VACUUM INTO` therefore copies it into every backup.
  - iOS stores only the userId.

  **Fix 3b:** the core stores only `{server, userId}`, and secrets stay in Keychain / the OS keyring.

### 4. A typed native-bridge protocol (TS → generated Swift).

**Fix:** add `editor-host/protocol.ts`, declaring:
- the event union (name and payload),
- `EditorApi`/`ReviewApi`,
- the `ExecCommand` union, the editor-state shape and the protocol version,
- the URL schemes and entry files.

Generate `BridgeProtocol.swift` in `scripts/build-ios-web.sh`. A decode failure should throw instead of quietly producing an empty value. Route all JS→native traffic through `backend.ts`.

**Problems it solves:**
- **Untyped bridge, by git history.** `WebHost.swift` co-changed 13 times with `RootView.swift`, 6 with `editor-host/commands.ts` and 4 with `editor-host.test.mjs`.
- **Event names matched as strings.** `WebHost.swift:282-329` matches names against senders in `host.tsx`, `main.tsx`, `store.ts` and `saved-image.tsx`. `"viewState"`, `"cardsChanged"` and `"skip-cards-created-today"` have no shared definition.
- **Hand-mirrored shapes.** `EditorState` (`WebHost.swift:53-66`) mirrors `commands.ts:44-71` by hand, and `Heading` mirrors `host.tsx:171-175`.
- **Exec commands checked only at runtime.** About 25 command strings in `FormattingBar.swift`/`RootView.swift` are checked against the `commands.ts:77-169` switch only when they run. `host.tsx:108` keeps a second list of read-only commands.
- **Swallowed decode failures.**
  - `WebHost.swift:308` decodes headings with `try?`, so the outline empties without any error.
  - `:319-325` logs state decode failures only in DEBUG.
- **Calls that bypass the bridge.** `FormattingBar.swift:198` writes raw JS behind `try?`. `editor-host/review.tsx:31` hand-builds `postMessage` instead of using `postNativeEvent`.
- **Unused bits.** `protocolVersion: 1` is sent and never read. `memnoterEditor.blur` has no caller.
- **One setting, three channels.** `skipCardsCreatedToday` reaches the web host 3 ways:
  - an injected global (`WebHost.swift:133`),
  - an event (`:341`),
  - inside the persisted `editorViewState` (`:289`).

  These can disagree.
- **Copied values.** `HIGHLIGHT_COLORS` is copied into `FormattingBar.swift:98`.
- **Bundle bloat.** `host.tsx:1` imports `lib/sync/manager.ts`, which pulls the whole desktop sync engine into the iPad bundle for two cache helpers. Split them out into `lib/sync/apply-remote.ts`.

### 5. One review session, written once (web), with the native side only for chrome.

**Fix:**
- Extract the queue, rating, undo/redo and learn-ahead logic from `routes/review.tsx` into `lib/review-session.ts`.
- The review web host exposes `load/rate/undo/redo` and posts `{counts, currentKind, intervals, canUndo, canRedo}`. Swift draws the buttons from that state.
- Put the palette in one token file that both Tailwind and generated Swift read.
- The core owns the two-way-sibling rule: `review_card` returns the sibling's `availableAt`.

**Problems it solves:**
- **Different queries.** `ReviewView.swift:217` asks `due_cards` for `now`; the web asks for `endOfDay` and then applies `nextInQueue(..., learnAhead)`. So on iOS, cards due later today never join the session, even though the header shows "+N later".
- **Missing steps on iOS.** It never runs `unindexed_card_modules`/`flushCardSyncs` before loading.
- **Colors already drifted.** The uncommitted contrast pass changed `card-counts.tsx` and `review.tsx` to `-800` shades. `ReviewView.swift:114-116,153-154` still has the old values.
- **Copied logic.**
  - The undo/redo stacks (`ReviewView.swift:252-281` vs `review.tsx:243-341`).
  - `ReviewCountKind` and its label (`ReviewView.swift:295-323` vs `card-counts.tsx:13-27`).
  - The day-cutoff math, 3 times in Swift plus once in `card-sync.ts`.
- **Sibling rule written in both SQL and TS.** `cards.rs:320-330` has `':reverse'` arithmetic and `600000` ms. `fsrs.ts:159-178` has `SIBLING_DELAY_MS` and "mirror the core" comments.
- **FSRS field list spelled out 6 times** in the core (`sync.rs:40-49,356-393`, `cards.rs:340-375,452-527`), plus 3 Swift structs.
- **Home screen drift.** The home shortcuts and the recent-modules logic are copied (`HomeView.swift:10-18`, `MemnoterApp.swift:40-48` vs `routes/index.tsx`), and the two already differ.
- **Test isolation.** `ReviewView.swift:75` builds `WebSession` without `preferences:`, which breaks UI-test isolation.

### 6. One action and shortcut table.

**Fix:** add `lib/shortcuts.ts`, with entries `{id, title, keys: "Mod-Alt-s", run, menuId?}`.
- Extensions bind from `keys`. Every hint is `formatKeys(keys)`.
- The palette, home page, slash menu, bubble menus, find bar and native-menu dispatch all read from this table.
- One platform module replaces the 4 detectors: `utils.ts:9` `MOD_KEY`, `platform.ts:2` `IS_IOS`, `app-events.ts:6` `/Mac/` and `routes/index.tsx:13` `IS_MAC`.

**Problems it solves:**
- **Each shortcut lives in 4–6 places.** The places are the keymap, `menu.rs:10-13`, the hint text, the palette entry, the slash hint and the home list. `lib/commands.ts:9-10` admits the gap: "`shortcut` is only shown, not bound".
- **Copied glyph helpers.** `slash-menu.tsx:34-37,144`, `find-bar.tsx:34-35`, `routes/index.tsx:13-27` each have their own.
- **Mixed hint formats in one toolbar.** `text-bubble-menu.tsx:107-194` shows both `⌘Shift+S` and `⌘⇧C`.
- **Wrong on Windows.** `command-palette.tsx:91,101` hard-codes `"⌘D"`/`"⌘F"`.
- **Advertised but unbound.** ⌘N and ⌘, are shown in the UI but bound only by the native menu, so nothing binds them on hosts without that menu.
- **Bound twice.** ⌘D is bound both in JS (`ui/sidebar.tsx:103-116`) and in the native menu, so `usesNativeMenuShortcuts` has to decide which one wins.

### 7. A "closed note changed" service plus one write-lifecycle owner.

**Fix:**
- **`lib/note-index.ts`:**
  - `loadStoredNote(id)`: `get_content`, then reconcile, then apply pending saves.
  - `refreshDerived(id)`: search plus cards, with one queue and one retry policy.
  - `startBackfill()`: drives both backfills.

  Start it from one bootstrap shared by `__root.tsx` and `editor-host/main.tsx`.
- **`write-lifecycle.ts`:**
  - `isWriteAdmitted()`/`assertWritable()`;
  - `registerFlusher(name, fn)` + `flushAll()`;
  - a `MUTATIONS` constant.

  Feature modules register themselves with it, instead of `write-lifecycle` importing them.

**Problems it solves:**
- **Two loaders, two results.** `card-backfill.ts:18-26` applies pending saves; `search-index.ts:141-146` doesn't. So cards and search can be built from different text.
- **Two backfill loops with different pacing.** `card-backfill.ts:76-99` and `search-index.ts:152-178`.
- **Two copies of the same debounce-and-flush-on-quit registry.** `card-sync.ts:17-25` and `search-index.ts:22-40`.
- **Callers repeat "search then cards".** Three callers do it in sequence: `sync/manager.ts:95-97` and twice in `import-module.ts:66-70`. The second of those sits under a bare `catch {}` with an unbounded 10s retry that never stops.
- **iOS search may never backfill.** Search backfill is started only from `command-palette.tsx:124`. iOS never runs it, so it would never reindex after an `EXTRACTOR_VERSION` bump. This comes from reading the call graph and is not verified on a device.
- **Hard-wired flushes, with a partial copy.** `write-lifecycle.ts:4-5,135-139` imports card-sync and search-index to flush them. `backups.ts:9-27` re-implements a subset of this: it doesn't flush search or check failed images.
- **One flag per caller.** `exclusiveWrite` has 4 flags, each used by one caller: `discard`, `retain`, `retryImages`, `excludedMutation`.
- **Inconsistent admission checks.** Raw `saveQueue.isSuspended()` appears ~15 times across lib and components. `writeCards` checks only that, while `writeOperation` also checks `exclusive`.
- **Mutation keys as bare strings.** `"restore-backup"` appears in 5 files.
- **Dead seam.** `card-writes.ts:16` `drainCardWrites` is used only by its test.
- **"Flush everything" by trick.** `host.tsx:94,104` uses `exclusiveWrite(async () => {})` for it.

### 8. A note data layer in `lib/`, and an editor schema with no React in it.

**Fix:**
- **Data hooks and helpers:** `useModules()`, `modulesCache.{rename,remove,invalidate}`, and `useNoteDocument(moduleId)`, which owns compaction, uploads, the blob reader and save attachment.
- **`content.ts` as the only cache writer.** It owns `contentKey()`, `LOAD_ORIGIN` and `appendSavedUpdate()`.
- **A schema factory with no React.** It holds node/mark specs, attributes and plugins. Node views and menus are injected by `Tiptap.tsx`. Headless editors (backfill, import, sync) then stop loading React UI.

**Problems it solves:**
- **The modules query is copied.** The `["modules"]` query appears 7 times, and its cache is patched by hand in 5 more places (`rename-module.tsx:38` is typed `any`).
- **Hand-written cache keys.**
  - `["content", id]` appears in 9 places, even though `content.ts:119` owns it.
  - The `"tauri-load"` origin appears in 5.
- **Duplicate save code.** `saves.ts:18-28` and `sync/manager.ts:112-116` are the same "ack, then append to cache" code.
- **`Tiptap.tsx` mixes view and persistence.** It is a view that also does compaction (`96-126`, `386-447`), uploads (`128-156`) and save wiring (`158-202`). That explains why it changed with desktop `lib.rs` in 12 commits.
- **lib imports components.** `lib/note-extensions.ts:21-24` imports `slash-menu`, `latex-menu` and `saved-image`, so `card-backfill`, `import-module` and `sync/manager` load React UI. `sync/file-requests.ts` exists only to work around this.
- **Schema config in a component.** `IMAGE_TYPES` lives in `components/slash-menu.tsx:39` and is consumed by the schema.
- **Other upward imports.** `lib/inline-math.tsx:14-15` imports `ui/button`/`tooltip`, and `lib/review-actions.ts:1` imports a type from `components/card-counts`.
- **`saved-image.tsx` does everything.** It is 774 lines covering schema, plugins, crop dialog and node view, and `setLayout` lists every attribute twice (`390,392`).

### 9. An `EditorHost` context (native vs desktop, scroll container, focus policy).

**Problems it solves:**
- **A one-caller prop.** `hostOnly` (`Tiptap.tsx:45,249,269-273,469-480`) is only true when `isNativeHost()` is.
- **Dead render.** `Tiptap.tsx:472` renders a `TableOfContents` that always returns null on native.
- **One fact, two sources in one handler.** `saved-image.tsx:349-364` reads `isNativeHost()` and the `data-native-editor` DOM attribute in the same handler.
- **The scroll container is a string contract.** `.app-scroll-container` is set in 2 places and queried by string in ~14 files. `note-extensions.ts:103` even does a global `document.querySelector` for it.
- **An event that works by coincidence.** `"memnoter:reveal"` (`editor-host/scroll.ts:40,65`) works only because `view-persistence.ts:22` happens to list it among the user-scroll events.
- **Duplicated theme sync.** `main.tsx:13-29` and `editor-host/theme.ts` are the same code.

### 10. One outline model: `lib/outline.ts`, computed once per doc.

**Problems it solves:**
- **Seven separate walks.** Seven places compute "a section runs to the next heading at the same or higher level": `sections.ts:22-40`, `section-focus.ts:35-65` and `:75-104`, `heading-fold.ts:47-61`, `heading-numbering.ts:7-20`, `cards.ts:321-345` and `editor-host/commands.ts:16-26`.
- **The walks already disagree.**
  - `descendants` vs top-level `forEach`.
  - Trimmed vs untrimmed titles.
- **Copied strings.**
  - `"Untitled section"` ×4, including `ContentsPopover.swift:30`.
  - `data-toc-id` read directly ×6.

### 11. One owner for module rows, image assets and indexes in the core; ordered migrations.

**Fix:**
- **Module rows:** `module_rows::{insert, rename}`.
- **An `assets` module:**
  - `path(id)` builds the only `files/<id>`;
  - `write(id, bytes)` has one durability policy;
  - `referenced_by()` is the single query.
- **Hosts work from ids.** The core stops exposing absolute `FileType.path`, and hosts build URLs from the id.
- **`invalidate_indexes(tx, module)`.**
- **Migrations:** a `MIGRATIONS` list driven by `PRAGMA user_version`. Card reindexing takes an extractor version from TS, as search already does.

**Problems it solves:**
- **Module writes repeated.**
  - Create is written 3× (`content.rs:13-41`, `import.rs:40-56`, `sync.rs:500-519`).
  - Rename is written 2×.
  - `search_index` is written from 5 files.
- **Three different file-write policies.** `fs::write`, `create_new`+fsync, and `.partial`+rename. Stale `.partial` files are never cleaned, because cleanup skips non-UUID names.
- **The path column is recomputed, then checked again.** It is recomputed on every open (`db.rs:97-127`), yet still checked against `files/<id>` in 6 places. The iPad bridge parses it back apart (`backend.ts:78-88`), and `rewrite_file_paths` in restore is redundant.
- **"Which image a note references" written 4 times.** `asset_refs.rs:69`, `files.rs:138-143`, `content.rs:93-99` and `cards.rs:246-258`.
- **Sync deletes other modules' tables.** `apply_remote` deletes rows from tables owned by search and cards (`sync.rs:900-911`).
- **Ad-hoc migrations.** There are four hand-rolled "add the column if missing" checks plus an `AUTOINCREMENT` string sniff.
- **A dead column.** `card_indexed_modules.syntax_version` is never read. Because of it, a TS card-syntax change needs a Rust migration.
- **Errors keyed on message text.** Typed errors (`CoreError {StaleGeneration, Unavailable, Conflict, NotFound, Storage}`) would replace `error.starts_with("Database unavailable.")` (`backups.rs:322-330`) and the `STALE_GENERATION` string that no client checks. Today FFI's single `Storage` variant can't tell a review conflict from a real failure.

### 12. Card-id grammar in one module, with a Rust golden test.

**Problems it solves:**
- **The id is built by hand everywhere.** It is rebuilt by hand in 5 places: `cards.ts:274,336`, `saved-image.tsx:200`, `fsrs.ts:170-178` and the SQL in `cards.rs:320-329`.
- **A parser that disagrees with the validator.** `blockIdOf` (`cards.ts:355`) assumes cloze ids start with `c`, but `validatedClozeIds` (`cards.ts:250-257`) accepts any id except `"reverse"`, including ones from pasted or persisted HTML. For such an id, `renewCardIds` and `revealCard` miss the block. This is a latent bug.
- **Copied helpers.** `isCardBlock` is duplicated (`cards.ts:213`, `flashcards.ts:200`). The `["image","inlineImage"]` list appears 8 times. FSRS state numbers are mapped inline (`flashcards.ts:67`).

---

## Smaller fixes, no shared root cause

- **UI primitives:**
  - Add a `pressed` variant to `ui/button`, plus one icon `ToolButton`. Today 4 copies exist: `MarkButton`, `ToggleButton`, `IconButton`, `ToolbarButton`.
  - Add a `Surface` primitive. The popover surface class string is copied 15 times.
  - Make CSS read a `--ghost-hover` token instead of matching Tailwind class text (`App.css:1498-1502` selects `[class~="dark:hover:bg-muted/50"]`).
  - Use one toast region. `save-status.tsx:108` and `import-folder.tsx:94` both sit at `fixed bottom-4 right-4 z-50` and overlap.
- **Suggestion menus:**
  - Add a shared `suggestionRenderer(Component)` and `useListNavigation`. Slash and LaTeX menus repeat the renderer lifecycle, the key handling and the scroll-into-view.
  - LaTeX has its own safe-triangle check, when `lib/menu-aim.ts` already has one.
- **Images:**
  - Add a `useResolvedImage(fileId)` hook, written twice today (`saved-image.tsx:126-131`, `card-face.tsx:138-151`).
  - Move the double-tap thresholds into shared constants.
  - Use one modal implementation. Today there are three: a hand-rolled crop dialog with no focus trap, a native `<dialog>`, and the `Dialog` primitive.
- **Native undo/redo menu bridge:** written twice (`Tiptap.tsx:323-353`, `review.tsx:364-383`). Make it a `useNativeHistory()` hook.
- **Review route:**
  - Drop `openReview` and keep the route's `beforeLoad` flush. The `<Link>`s skip `openReview` anyway.
  - Merge the three copies of the try/catch/finally around rate, undo and redo.
- **Module dialogs:**
  - Split `CreateModule`'s 4-behavior `global` prop into separate components.
  - Share the name-form and confirm-dialog patterns. The `sumbitted` typo appears in both copies.
- **Folder import contract:**
  - The image-extension list is in both `import_folder.rs:116` and `folder-import.ts:9`.
  - Hidden-file filtering happens on both sides.
  - `Entry.bytes` is always `None`.
  - The `ROOTS` global requires calling the picker first, which callers just have to know.
- **Front-matter regex:** written 3 times, slightly differently (`markdown-paste.ts:12,154`, `folder-import.ts:77`).
- **Search markers:** `\u0002`/`\u0003` are duplicated in `search.rs:12-13` and `search-marks.ts:3-4`.
- **Menu ids:** `"import-folder"`, `"editor-undo"` and `"editor-redo"` are literals in `menu.rs`, mirrored as strings in TS. `"memnoter-import-folder"` is the one app event without a constant.
- **Daily backup:** `daily_backup` should return its result. Today it spawns a thread and joins it at once (`memnoter-ffi/src/lib.rs:27-32`), and errors go only to `eprintln!`, so iOS never sees a backup failure.
- **Test-only parameter:** `files_dir: Option<&Path>` exists for tests only (`sync.rs:684-690,831-834`). With `None`, deletions are skipped, so tests run a different path from production.
- **CSS:**
  - Merge the selectors split across blocks: `.tiptap` ×5, `.inline-math-widget` ×3.
  - Remove the rules that only undo others (`App.css:158`, `:321-333`).
  - Add a z-index scale. Today the values are 5/10/20/30/40/50/60/100, with no scale.
  - Add `--cloze`/`--cloze-bg` tokens instead of borrowing `--chart-1`.
  - The one 1,600-line `App.css` changes with everything. Colocate feature styles with their components.

## Surplus to delete

- **Unused primitives:**
  - 40 unused shadcn exports.
  - `ui/skeleton.tsx` and `ui/separator.tsx`, used only by unused exports.
  - The sidebar cookie that nothing reads (`ui/sidebar.tsx:91`).
- **Duplicate class-merge helper:** the npm `cn` package is used next to `@/lib/utils`'s `cn`.
- **Dead exports and constants:** `FSRS_VERSION`, `startOfDay`, `VAULT_DOC`, `BLOB_REF_FORMAT`, `PBKDF2_ITERATIONS`, `FatalSyncError`, `linkEditorKey`, `imageDropPosition`, `moveImage`, `SaveQueue`, the `OUTBOX_EVENT` constant, `RemoteEntry.seq`, and the `syntax_version` column.
- **Pass-through wrappers:** `recent-modules.ts`, `reindexStoredCards`, `backups::list_backups`→`list`, and about 10 more lock-wrapper/inner-function pairs exported through glob re-exports. Desktop then does `use memnoter_core::*`.
- **Probably dead (confirm first):** the Tauri-mobile entry point and `apps/desktop/gen/apple`, which `sync-version.mjs:21-25` still writes to. Confirm nobody runs `tauri ios`.
- **Stale docs:** `crates/memnoter-core/README.md:3-4` says "No UniFFI bindings yet", and `protocol.ts:19` says "R2 in phase 2".

## Bugs found along the way

1. **Breadcrumb current item.** `components/file-breadcrumb.tsx:180` compares an index inside `slice(-2)` against `sectionPath.length - 1`. With 3+ crumbs, the current section renders as a link instead of the current page. Confirmed by reading the code.
2. **iOS review misses cards due later today.** No learn-ahead, and `due_cards` is asked for `now` instead of `endOfDay` (fix 5).
3. **iOS outbox nudge misses some writes.** `import_module` and `restore_backup` don't trigger it, so those changes wait for the 15s ticker (fix 2).
4. **Sync secrets in backups.** The desktop sync token and raw AES key sit in `main.db`, so they are copied into every backup (fix 3b).
5. **`blockIdOf` vs `validatedClozeIds` mismatch** for cloze ids that don't start with `c` (fix 12).
6. **New notes get placeholder content.** `Tiptap.tsx:356-363` writes and saves `<p>Hello World!</p>` into every empty note.
7. **Import-folder menu item may open the wrong dialog.** It also fires `NEW_MODULE_EVENT` (`app-events.ts:22`). It may be intentional if the create dialog hosts import; check it.
8. **Ping mismatch.** iOS's control-frame pings may wake the hibernated Durable Object; the text `"ping"` would not (fix 3). Unverified.

## Comments (restate-the-code)

About 75 comments only restate the code, or are stale or wrong: ~15 in Rust, ~35 in lib, ~25 in components and CSS, ~5 in iOS and the worker. Comments that record external facts (WebKit, SQLite, the CF runtime) are fine and should stay. A representative sample:

- **Wrong:** `view-persistence.ts:148` describes scroll restore above a set that holds save callbacks.
- **Stale:**
  - `Tiptap.tsx:5` `// src/Tiptap.tsx` (old path).
  - `App.css:417` "Links, if enabled later".
  - `cards.ts:17`.
  - `crates/memnoter-core/README.md:3-4`.
  - `ReviewView.swift:3-4,285` claims parity with desktop that no longer exists.
  - `SyncClient.swift:84` says "Rust owns … crypto".
- **Leftovers:** "ai-suggested change" notes at `Tiptap.tsx:170,180,280` and `files.rs:35`.
- **Restating:**
  - `card-sync.ts:225` "The next local midnight".
  - `backups.rs:93` "Newest first." above a descending sort.
  - `sync.rs:125,143,184`.
  - `ui/sidebar.tsx:78-119`.
  - `menu.rs:9`.
  - `dispatch.rs:6`.
- **Caller lists that will rot:** `card-sync.ts:27`, `backups.ts:8`, `recent-modules.ts:3`, `flashcards.ts:190`.
- **Misplaced:** the FTS comment at `db.rs:218-222` sits above the numbering migration.

The comments that explain workarounds (timers, retries) should go when fixes 2, 7 and 9 remove the workarounds, not before.

## Tests

**Suite:** 272 tests.
- 1st run: 5 failures. One was a stale expectation from a mid-run edit; four were flaky (Vite dependency optimization reloading pages under parallel runs).
- 2nd run: all green. Every failing file also passes on its own.
- None of the failures was a product bug.

### Do first

1. **A shared browser harness** in `tests/support/browser.mjs`, with a per-file Vite cache folder, a dependency warmup and one fake-Tauri/native builder.
   - It fixes the 4 flaky tests. Seven files share `node_modules/.vite` while running in parallel.
   - It removes the copied boilerplate from about 22 files.
2. **A real-schema editor helper** in `tests/support/editor.mjs`. Today 8+ tests hand-build ProseMirror schemas, one of them commented "same node names as the editor's", so a test can pass while the real schema drops a node. That is exactly the risk in the schema-rollout note. This depends on fix 8's React-free schema.
3. **Commit a small fixture vault** in `tests/fixtures/`. Today `folder-import:26`, `import-integration:68`, `note-paste:31,45` and `large-note` skip unless `/Users/vladyslavnalyvaiko/Downloads/...` exists, so they never run in CI.

### Remove

These can't fail, or only repeat the implementation:
- **`large-note.test.mjs`:** a benchmark whose assertions are `nodes > 0` and "p95 is finite". Make it a `bench:` script.
- **`outline-refresh.test.mjs:38-40`:** no assertion.
- **`review-host.test.mjs:32`:** `assert.ok` on a string that is always set.
- **`crates/memnoter-core/tests/dispatch.rs:63-68`:** can't fail (see fix 1).
- **`cards-style.test.mjs:50-62`:** asserts SVG path substrings and background-size arithmetic copied from the CSS.
- **Expected values built by re-running production logic:**
  - `folder-import.test.mjs:28-37` re-derives them with the same regex and markdown-it that production uses.
  - `note-paste.test.mjs:47,54` does the same.

  Replace both with fixed expected values from fixtures.
- **`occlusion.test.mjs:64`:** expects `.6000000000000001`. Use a tolerance.
- **Leftover side effects:**
  - `import-integration.test.mjs:80-84` writes into another agent session's scratchpad.
  - `text-selection` writes screenshots to `/tmp` on every run.

### Rewrite against behavior

- **CSS and source as text:**
  - `cards-style.test.mjs` parses `App.css`; it changed with App.css in 3 of its 11 commits.
  - `contrast.test.mjs:18-32` greps `.tsx` for class strings and builds synthetic specimens from class names.
  - `text-selection.test.mjs:241-243` regexes CSS text.

  Instead, measure rendered colors and sizes on real components.
- **Plugin internals:** `heading-numbering`, `heading-fold`, `markdown-paste-plugin`, and `editor-commands:82,114-116,165-167`. Drive a real `Editor` and assert `editorState()`, `editorOutline()` and `getFoldedIds()`.
- **Implementation details:**
  - `editor-host:247-259` calls `revealCaret` with a fake view.
  - `review-scope:170-191` counts `setInterval` calls.
  - `fsrs.test:44` asserts the scheduler is cached.
  - `cards.test:56,100-102,202-237` asserts parser positions and `planCardIds`; `cards-editor` already covers the same through real transactions.
- **DOM details:**
  - `import-dialog`: `.group`, `parentElement`, a 36px row height, `translateY`.
  - `table-of-contents`: exact paddings and dash counts. It changed with `table-of-contents.tsx` in 5 of its 8 commits.
  - `card-info`: class names.
  - `image-preview`: `scale(2.5)` regexes.

  Use roles, accessible names and relative geometry instead.
- **iOS and worker:**
  - `SyncTransferTests.swift:44-46` sleeps 450 ms against a private 400 ms debounce.
  - The `SyncFileTransfers` tests pin the exact command sequence and retry counters.
  - `CoreClientTests.swift:58-70` is a hand-written fake of the worker contract.
  - `ReviewCountsTests` tests the Swift copy of the counts logic, so it can't catch drift; that goes with fix 5.
  - `apps/sync/test/sync.test.ts:317`, "without waking", can't fail on waking.
  - `:147-149` depends on engine reconnect jitter.
- **Rust:**
  - Tests insert raw `files` rows and lock `db.conn` directly.
  - `tests.rs:508-517` asserts the exact FTS query string.
  - Move these to a temp `Core` + `dispatch`.

### Merge

- `restore-sync` + `restore-transfer`.
- Command behavior from `editor-host`, `highlight` and `editor-commands` goes into `editor-commands`. Keep `editor-host` for the bridge, layout and scroll.
- The `import-dialog` and `import-integration` dialog flows.
- `folder-import` and `import-integration`, which assert the same real-folder counts.

### Seams

- Delete `drainCardWrites`, and test "exclusiveWrite waits for in-flight `writeCards`" instead.
- Minor: `getCommands`, `tabSpacing`, `detectBackground`/`adaptPixels` and `LATEX_ENTRIES` are exported only for tests.

### Not tested in CI

- No CI job runs `apps/ios/Tests`.
- `NativeSyncEndToEndTests` skips unless `wrangler dev` is running, so no Swift client is ever checked against the worker.
- Add a macOS job running `xcodebuild test` with `wrangler dev` alongside it.
- Version sources disagree. `release.yml` overrides `Version.xcconfig` on the command line and hard-codes a build-number floor (`202611031741`).

---

## Suggested order: one PR per phase

The order follows dependencies: each phase removes duplication the next one would otherwise have to work around.

| # | Phase | Fixes | Why here |
|---|---|---|---|
| 0 | Safety net | Tests 1–3 (harness, real schema, fixture vault), iOS CI job, the quick bugs (breadcrumb, Hello World) | You need trustworthy tests before moving contracts |
| 1 | Core owns commands + outbox | 1, 2, 11 (typed errors, migrations, assets) | Biggest Rust↔host duplication; unblocks generated types |
| 2 | Shared-ui layering | 8, 7, 9, 10, 12 | Removes lib→components imports and the two-loader split; makes the headless schema possible |
| 3 | Bridge contract | 4, 6 | Generated Swift bridge, one shortcut table; ends the `WebHost`↔`RootView`↔`commands.ts` churn |
| 4 | One review session | 5 | Needs phase 3's bridge; fixes the iOS learn-ahead bug and the color drift |
| 5 | One sync engine | 3, 3b | Largest change; needs the core command and outbox signals from phase 1 |
| 6 | Sweep | Smaller fixes, surplus, comments, remaining test rewrites | Last, so the deletes aren't redone after the moves |

**How to tell it's working:** count the special cases left: timers used for synchronization, platform checks, swallowed errors, flags that serve one caller. Today there are about 150. Fixes 2, 3, 7 and 9 alone should remove roughly half.
