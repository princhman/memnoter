# shared-ui rules

This code ships to desktop, iPad and iPhone at once.

- **Parity.** Check a behaviour or styling change on desktop and iPad (and iPhone
  for layout). Settings belong in Settings on every platform, not in toolbars.
- **Colour.** The accent is `--primary` in `src/App.css`. No default blue,
  violet or new purple shades. Primary buttons are purple.
- **No decorative chrome.** No borders, dividers or outlines unless contrast
  needs them. Don't re-add one that was removed.
- **Contrast.** Check light and dark mode; selected and highlighted states must
  be easy to read.
- **Editor host on iOS** (`src/editor-host/`): scroll, keyboard and caret changes
  always need `tests/editor-host.test.mjs` coverage, even in "don't test" mode.
  Untested fixes here keep bringing old bugs back.
