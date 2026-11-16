# shared-ui rules

This code ships to desktop, iPad and iPhone at once.

- **Parity.** This code reaches every platform at once, but follow "One
  platform first" in the root `AGENTS.md`: get it right where the user is
  testing, then check Mac, Windows (Chromium), iPad and iPhone once they
  approve. Settings belong in Settings on every platform, not in toolbars.
- **Update notices.** Use the app dialog with Download update and Later, matching
  the approved native popup so local work remains available after dismissal.
  Required updates take priority; retries/navigation must not reopen the dialog.
- **Colour.** The accent is `--primary` in `src/App.css`. No default blue,
  violet or new purple shades. Primary buttons are purple.
- **No decorative chrome.** No borders, dividers or outlines unless contrast
  needs them. Don't re-add one that was removed.
- **Question bank controls.** Crop editing belongs in one ellipsis menu over
  the image, styled like regular saved images; don't add side action rails.
  Question and part rename/move/delete actions belong only in context menus,
  without row ellipsis buttons on desktop. iPad also exposes these actions in a
  visible row ellipsis menu and uses a drag handle so other row swipes scroll. Rename in a dialog with room for the label.
  Enable dragging only in explicit Reorder mode, with a labeled Reorder/Done
  toggle. That mode hides crops and starts questions and nested parts folded;
  chevrons and clickable part counts reveal children deliberately. Temporary
  folds never overwrite reading folds; Done restores them. Show an accent
  insertion line for sibling placement and an inside highlight for nesting, only
  for a valid move. A part on a question boundary becomes a new question; show
  that outcome before drop. Hovering a valid folded row for two seconds opens
  only its temporary Reorder fold.
  Drag desktop question/part rows without
  grips; preserve disclosure, rename and menu interactions. Pickup, drop and
  cancel must preserve outline geometry and folds except intentional hover expansion.
  Collapsed rows and part counts keep the same dimensions and spacing when
  switching between reading and Reorder modes; omit the instruction sentence.
  Question edge targets include the whole visible question subtree for reordering.
  Dropping a question on the middle of another question or part nests its entire
  content there. Only valid inside intent uses delayed hover expansion. Nesting
  targets use a purple accent row highlight, without a colored left stripe.
  Adjacent siblings share one between-row target: after A and before B use the
  same insertion coordinate, marker and outcome.
- **Stable editor geometry.** Focus and hover must not move or resize note text,
  status dots, or following blocks. Reveal editing syntax in place or out of
  flow; don't reserve large blank gaps to hide movement. This keeps the reading
  position and pointer target stable while moving between reading and editing.
- **Contrast.** Check light and dark mode; selected and highlighted states must
  be easy to read.
- **Section navigation.** Put keyboard hints in hover tooltips, not permanent
  sidebar or menu badges. Highlight selected module/section menu rows instead
  of showing checkmarks. Use Option-N/F/Q/R for the current scope and
  Option-Shift-F/Q/R for All modules; sidebar tooltips show the latter.
  No G sequences. Notes has no global
  sidebar entry. Files/Questions/Review sidebar entries open All modules and
  highlight only there; module-scoped pages highlight their module instead.
- **Editor host on iOS** (`src/editor-host/`): scroll, keyboard and caret changes
  always need `tests/editor-host.test.mjs` coverage, even in "don't test" mode.
  Untested fixes here keep bringing old bugs back.
- **Worksheet answers.** Reuse the shared editor extensions and math views from
  notes. Do not build a separate LaTeX parser or Write/Preview editor.
  Keep the answer field compact with a subtle border and an empty-state typing
  and drawing hint, so the editable area is visible beneath each question.
  On desktop the field is a read-only preview; clicking it opens the answer in
  a modal with the part's crops (no inline answer editing). iPad/iPhone keep
  inline answers. Desktop mirrors the iPad toolbar in the window header: the
  breadcrumb becomes a back chevron and the worksheet title; the top right
  holds previous/next with question pills (menu above 3) and a purple Finish
  pill. No in-page title, footer, module heading or "Saved" line.
  Worksheet questions use the QuestionBank reading layout: saved root names,
  own parenthesized part labels, identical width, typography, crop gutter and
  nesting gaps. Keep compact leaf answers below crops in the content column.
  Pinned crops stay read-only; folding hides crops, answers and descendants
  without unmounting answer editors or losing their autosave state.
