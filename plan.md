## Current pass

- [x] Compare the old backlog with the current code and record what already exists.
- [x] Open images full screen from their toolbar or by double-clicking, for both
  block and inline images. Fit the image to the window, support Escape
  and a close button, and return focus to the editor without changing the note.
  Verified in WebKit for block and inline images; all 127 frontend tests,
  `pnpm build` and `pnpm lint` pass.
  Full-screen viewing also preserves theme-adapted colours and follows theme
  changes while open, using the same displayed copy as the note.
- [x] Recheck the reported math issues. Adjacent typing in a collaborative editor
  stayed stable in WebKit: the rendered math block and its KaTeX DOM were retained.
  On 2026-11-03, the user said the issue was likely fixed earlier and asked to
  leave it alone. Both the blinking and highlighting investigations are parked;
  no math code was changed. Reopen only with a current reproduction.

## Editor improvements

- [x] Tab for spacing: define behavior in prose, lists and code. Preserve existing
  Tab actions for suggestion acceptance, LaTeX placeholders and list indentation.
  Added literal prose tabs and two-space code indent/outdent; 129 tests, lint
  and build pass.
- [ ] Automatic chapter numbering: display numbers on headings and in the outline
  without adding them to note text. Decide whether numbering is per module and
  whether it is optional before implementing.
- [ ] Move images within a note. Verify drag handles for block and inline images,
  drop placement, preservation of captions and masks, and undo/redo.
- [ ] Context actions on module rows: rename, review and delete using the existing
  actions, with keyboard access and the same delete confirmation.
- [ ] Audit button tooltips. The shared IconTooltip component and image toolbar
  tooltips exist; check remaining icon-only actions and expose their shortcuts.

## Larger features

- [ ] Drawings: define a first version with pen, eraser, undo and local persistence.
  Decide whether drawings are editable embedded assets or exported images.
- [ ] Prepare for the ipad

## Proposed additions

These are new backlog ideas, not commitments for this pass.

- [ ] Image viewer zoom and pan, with a reset-to-fit action for detailed diagrams.
- [ ] Let the image viewer switch between the original and theme-adapted image.
- [ ] Add a searchable keyboard-shortcut reference using the existing action names.
- [ ] Offer Markdown export with images and LaTeX. Document how flashcards and
  occlusion masks are represented so export does not silently lose study content.
- [ ] Provide recovery help when loading a note fails: retry and access backups
  while retaining unsaved edits.

## Implemented since the original backlog

Confirmed in source; this is not a claim that every interaction has been re-tested
on every desktop platform during this pass.

- [x] Slash menu for sections, headings, lists, quotes, code, images and math.
  See `src/components/slash-menu.tsx`.
- [x] LaTeX command suggestions and placeholder navigation.
  See `src/components/latex-menu.tsx`.
- [x] Preserve the open module, cursor, scroll position, focused section and folds.
  See `src/lib/view-persistence.ts` and `src/lib/store.ts`.
- [x] Folding headings, including keyboard fold/unfold commands.
  See `src/lib/heading-fold.ts`.
- [x] Adapt image colors and background to the current theme.
  See `src/lib/image-adapt.ts` and the image toolbar.
- [x] Sibling and subsection insertion commands and shortcuts.
  See `src/lib/sections.ts`. The remaining heading action is tracked above.
- [x] Flashcards: basic cards, clozes, image occlusion and scheduled review.
  See `docs/flashcards.md`.

## Historical completions

- [x] bubble functionality? When highlighting could operate on the piece of text
- [x] allow images within text 
- [x] image inline like in google docs, with ability to write around
- [x] cmd + f
- [x] update system (automatic updates) - create ci/cd
- [x] add ability for mathblock to be in the middle
- [x] when there is no space after $$, clicking "->" sends me to the next line
- [x] there is a weird space in between $$ when empty
- [x] sometimes the formula is dismissed one character before
- [x] add triangle so that hover pop up does not dismiss when moving my mouse 
- [x] create a logo! (4 dots? or )
- [x] rename the project to memnoter
- [x] during cursive the cursor is not cursive
- [x] alt + arrows to move text
- [x] show the outline of the document on the side of the page (contents or something)
- [x] the bug of when editing moving the page
- [x] add space bellow last piece of content so last sentence can be in the middle of the page
- [x] when i hover, i want to see what kind of heading that is - make it easier for me to add more 
- [x] ability to put cursor in front of the mathblock 
- [x] add a space after mathblock so can be dismissed with a click
- [x] remove autocapitalisation in the tiptap for macos
- [x] image resizing should only appear on click and not on hover
- [x] no text selection on the image
- [x] image editing tools, overlay and not insert 
- [x] image cropping
- [x] joing arrows into -> from - >
- [x] fold too many titles into eclipsis
- [x] scroller appears and shifts the layout 
- [x] image pasting
- [x] cmd+z functionality
- [x] title of the module on the module page
- [x] focusing on the title and enforcing title structure
- [x] automatic compaction
- [x] debug the content editor
- [x] renaming modules
- [x] design architecture (db)
- [x] write down rust for getting updates
- [x] set up tiptap sending yjs updates
- [x] test
