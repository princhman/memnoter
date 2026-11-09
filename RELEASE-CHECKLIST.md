# Release checklist

Manual acceptance tests to run before tagging a release. The next release is the
first after v0.1.3 and covers PRs #28–#37. Items marked **[new]** come from those
PRs and have never been in a release. Several of those PRs merged without CI as a
gate (#32, #37), and some say outright that physical devices and live sync were
not tested.

Test on **local release builds** (`pnpm tauri build`, and a Release-configuration
iOS build), not tagged ones. Pushing a `v*` tag publishes the GitHub release right
away, so everything up to §13 happens before you bump or tag. The dev build is
slow and gives misleading results.
Use a copy of real data, plus one fresh install with an empty data folder.

Devices: Mac (Apple silicon), iPad (physical, with Pencil), iPhone (physical),
plus a Windows machine and a Linux machine or VM, if you can.

---

## 0. Before building

- [ ] `pnpm check` passes locally, and CI is green on `main` (`check`, `sync-server`, `ios`)
- [ ] Re-run the iOS UI test that CI skips (`SectionFocusUITests/testContentsHierarchyFocusAndUnfocusRestoreWholeNote`) by hand on a simulator
- [ ] Release notes / README features list updated (PDFs, drawings, Anki import, iPhone, Mermaid, folders, tables)

## 1. Upgrade path (most important)

Old builds delete nodes and marks they don't recognise when they load a note. Update
every device before you edit on any of them.

- [ ] Install v0.1.3 and open a copy of a real database, then install the local build over it. All data is intact (the auto-updater itself is tested after release, in §13)
- [ ] Migrations run on a v0.1.3 database: sidebar order and folders (`sidebar_items`), PDF tables, drawing assets. Nothing is missing and the app doesn't crash
- [ ] The sync token and key move to the Keychain on first launch. You stay signed in, and the token is not left in `main.db` or in new backups
- [ ] Fresh install with no data: the welcome screen appears, and an empty note does **not** get "Hello World!"
- [ ] Restore a backup made by v0.1.3 into the new build

## 2. Editor basics (Mac)

- [x] Type, undo/redo, headings, lists, links (⌘L), code, inline code
- [x] Inline math ⌘⇧M, math block ⌘⌥M. **[new]** KaTeX shorthand `a^qbc` renders as `a^{qbc}`, and `x^2+y^2` renders unchanged
- [x] **[new]** `$\alp` + Tab inside an open `$` adds only the closing `$`
- [x] Fold and unfold sections. Reopening a module restores scroll position and folds
- [x] ⌘F find in note. ⌘K palette searches titles, body text and LaTeX, and jumps to the match
- [x] **[new]** Right-click opens the insert menu at the pointer: search works, Cut/Copy work, the list scrolls in a short window
- [x] **[new]** Slash menu and right-click menu show the same items (Mermaid, drawing, table…)
- [x] ⌘A in a **long** note, then copy: no freeze, and the whole note is copied
- [x] Paste Markdown / Obsidian content: tables, display formulas and highlights survive

### Tables **[new]**
- [x] Insert from the slash menu, the selection toolbar and the iPad format menu
- [x] The **+** bars on the right and bottom edges add a column or row
- [x] Cell toolbar: add row above/below, add column left/right, delete
- [x] Tab in the last cell adds a row. Undo/redo work correctly
- [x] A wide table scrolls horizontally without breaking the layout

### Colored highlights **[new]**
- [ ] All 5 colours on desktop and iPad. Highlight over inline math. Highlight inside a cloze
- [ ] Highlights appear on flashcard faces in review

### Mermaid **[new]**
- [ ] A Mermaid code block renders when the caret leaves it. Inside, you see the source and a live preview
- [ ] Invalid syntax shows an inline error, not a crash
- [ ] Follows the light/dark theme switch. A long note with many diagrams scrolls smoothly (lazy load)

### Contents rail (desktop) **[new]**
- [ ] Shows the top 2 levels plus the headings of the current section. Rows squeeze to fit
- [ ] Hovering a dash opens the subtree popup. The safe triangle keeps it open as you move toward it
- [ ] Focus/Unfocus a section. Unfocus on a short note doesn't jump
- [ ] Fold chevron sits in the left gutter and doesn't cover the heading number

## 3. Flashcards and review

- [ ] `Q :: A`, `Front ::: Back` (two-way, sibling waits 10 min), `{{cloze}}`, ⌘⇧C, joined clozes
- [ ] `a:::b` and inline code stay plain text. Shift+Enter makes a multi-line card
- [ ] Image occlusion: rectangle, ellipse, freehand, move/resize, joined masks
- [ ] Review all cards and review a single module. Space reveals, 1–4 grade, ⌘Z/⌘⇧Z undo/redo a grade
- [ ] Header counts (new / learning / review, `+n` later today). The current card's count is highlighted
- [ ] "Skip cards added to this device today" setting holds back new cards
- [ ] A card's breadcrumb opens it in its note. Clicking a hidden cloze or mask shows context without revealing it
- [ ] iPad review includes cards due later today
- [ ] A Mermaid block in a card shows its source (expected, not a bug)

## 4. Sidebar **[new]**

- [ ] Drag modules to reorder. A click still opens a module (drag starts after 5px)
- [ ] New folder, rename, collapse, delete (its modules stay). Drag modules into and out of folders
- [ ] The drag preview follows the pointer, including over a folder. Nothing snaps back or jumps after a drop
- [ ] Order and folders sync to the other device
- [ ] Beta pill opens the notice dialog. Settings → About shows the same text
- [ ] Settings Back button returns to the previous screen

## 5. Imports **[new]**

### Obsidian folder
- [ ] Import from the sidebar **+**, the palette and File → Import Folder…
- [ ] Steps: name, notes (reorder, skip), images (found/missing counts, "Look in another folder…"), formatting options
- [ ] Images copied, missing ones shown as placeholders, embeds/links removed as chosen
- [ ] Consecutive `Front ::: Back` lines become separate cards
- [ ] Cancel or fail midway leaves no partial module. Quitting during an import waits for it

### Anki `.apkg`
- [ ] A legacy export **and** a new (zstd) export from current Anki both import
- [ ] Basic, reversed, cloze (same number = joined), Image Occlusion Enhanced, built-in Image Occlusion
- [ ] Deck tree step: module / heading / merge / skip. Defaults look sensible. Names can be edited
- [ ] Review history comes in (due dates look plausible). Suspended cards come in as new, with a warning
- [ ] The sidebar updates straight after the import, with no stale list
- [ ] Toasts (Sonner) show results. "Not saved" Retry/Discard toast stays until the problem is resolved

## 6. PDFs **[new]** (biggest untested area)

- [ ] Add a PDF to a module on Mac, iPad and iPhone (native iOS import)
- [ ] Read it beside the note and fullscreen. Page and zoom are restored when you reopen it
- [ ] Quote text into the note. Quote an image region. Clicking the quote jumps to the source
- [ ] Highlights and comments are saved, survive a relaunch and sync to the other device
- [ ] Delete a PDF: tombstone syncs and the file goes on every device. No orphaned quotes crash the app
- [ ] A large PDF (100+ pages, scanned) opens without a hang or a memory spike
- [ ] PDF data survives backup → restore

## 7. Drawings **[new]**

- [ ] Mac: `/drawing`, then open the canvas from the pencil with mouse/trackpad. Draw, erase, undo/redo, save
- [ ] iPad: Note actions → Insert drawing. Apple Pencil on a **physical** iPad. Finger drawing
- [ ] iPhone: finger drawing is the default on first use
- [ ] The preview updates after saving. The old image stays visible with a spinner while the new one loads
- [ ] Recovery: kill the app mid-drawing, reopen, and the draft is offered. Discard works
- [ ] Draw on one device and the preview syncs to the other. Editing a drawing a peer deleted recovers cleanly
- [ ] Windows/Linux show the preview only (expected)

## 8. iPhone **[new]** (first release on phone)

- [ ] Fresh TestFlight install on a physical iPhone. Same bundle ID as iPad, so an upgrade from iPad TestFlight works
- [ ] Navigation: module list → note → back. Undo/redo visible. Keyboard accessory bar
- [ ] Contents: hierarchy, focus a section, jump to parent, search the full document, return to whole note
- [ ] Selection, paragraph style menu, typing with the keyboard open (nothing hidden behind it)
- [ ] Review screen works at phone width
- [ ] Error/recovery toasts stay inside the screen on a small phone (SE size)
- [ ] Light/dark, large text (Dynamic Type), VoiceOver basics

## 9. iPad

- [ ] Full regression of editor, format bar, Contents panel, review
- [ ] Hardware keyboard shortcuts. Split View / Stage Manager resizing
- [ ] Doesn't reset sync on launch. An idle iPad downloads incoming images

## 10. Sync and data safety

Use at least 3 devices: Mac + iPad + iPhone.

- [ ] Sign in with an email code on a new device. The first sync pulls everything (notes, images, PDFs, drawings, review history, folders)
- [ ] Edit the same note on two devices at once: changes merge, nothing is lost
- [ ] Offline edits on one device, then reconnect: changes sync both ways
- [ ] Grade a card on the iPad and the due date updates on the Mac
- [ ] Sign out, then sign in again. Sign-out errors are shown on iOS
- [ ] Save failure: simulate one (e.g. make the database read-only). The "Not saved" banner appears, editing continues, Retry works
- [ ] Quit right after typing: the last edit is saved
- [ ] Daily auto-backup is created and only the last 7 are kept. Manual Back up / Restore in Settings works

## 11. Platforms

- [ ] macOS Apple silicon and Intel `.dmg`: signed and notarized, opens without a Gatekeeper warning
- [ ] Windows `.msi` / `-setup.exe`: install, Ctrl shortcuts, no traffic-light padding, image writes work, drawing previews show
- [ ] Linux `.AppImage` / `.deb`: launches, editor works

## 12. Performance spot checks (release build)

- [ ] Open the largest real note: time to load, scroll and type is fine
- [ ] Moving the cursor and selecting in a long note doesn't lag (contents rail, heading numbers)
- [ ] ⌘K search across all modules is instant
- [ ] Review 50+ cards in a row with no slowdown

## 13. Cut the release

- [ ] Bump the version in `package.json`, then run `pnpm sync-version`. Check that `tauri.conf.json`, the three `Cargo.toml` files, `Cargo.lock` and `apps/ios/Version.xcconfig` all match
- [ ] Commit, merge to `main`, then push the `v*` tag. `release.yml` builds and publishes immediately

## 14. After release

- [ ] On a machine still running v0.1.3, the **auto-updater** finds the new version, downloads it and applies it on the next launch, with all data intact. Check each desktop platform
- [ ] GitHub release has every artifact and `latest.json`. The marketing site download links work
- [ ] TestFlight build uploaded (`release.yml`, or the `testflight_only` dispatch) and installs on iPad and iPhone
- [ ] Update your own devices in order before editing anything (see §1)
