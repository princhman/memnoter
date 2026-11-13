# shared-ui rules

This code ships to desktop, iPad and iPhone at once.

- **Parity.** This code reaches every platform at once, but follow "One
  platform first" in the root `AGENTS.md`: get it right where the user is
  testing, then check Mac, Windows (Chromium), iPad and iPhone once they
  approve. Settings belong in Settings on every platform, not in toolbars.
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
- **Editor host on iOS** (`src/editor-host/`): scroll, keyboard and caret changes
  always need `tests/editor-host.test.mjs` coverage, even in "don't test" mode.
  Untested fixes here keep bringing old bugs back.
