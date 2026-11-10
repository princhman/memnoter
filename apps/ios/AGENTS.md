# iOS rules

- **Native feel.** System navigation patterns and glass materials, not web-style
  bars. Toolbars scroll horizontally rather than hiding or reshuffling buttons.
  Accent colour is `Color("BrandAccent")`.
- **Devices.** "My iPad" = iPad Air, "my phone" = iPhone 11. Install with
  `scripts/ios-install.sh` (`--iphone`, `--all`; `--core` after `crates/`
  changes). It prints the build stamp that Settings → About shows. If the user
  says "nothing changed", compare those first.
- **Simulators.** Use T3 device tools. Never close or reuse another agent's
  device session; on `DEVICE_IN_USE`, wait or report. Release your own with
  `device_close` when done. Retained simulator ids are in `README.md`.
- Scroll, keyboard or caret changes in the editor need tests; see
  `apps/shared-ui/AGENTS.md`.
