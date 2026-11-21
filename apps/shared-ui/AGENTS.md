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
- **Question bank and worksheets.** The approved behaviour is in the Decisions
  section of Linear PRI-324. Read it before changing those screens, and add
  new decisions there, not here.
