# iOS rules

- **Native feel.** System navigation patterns and glass materials, not web-style
  bars. Toolbars scroll horizontally rather than hiding or reshuffling buttons.
  One glass treatment per toolbar group (`TabletGlassRow` / `TabletGlassPill`):
  never an opaque backing or a second capsule inside a glass pill, and toolbars
  that content scrolls under use the transparent host.
  Accent colour is `Color("BrandAccent")`.
- **Update notices.** Use native on-screen update dialogs, not persistent banners.
  Offer Open TestFlight and Later so local notes remain accessible; required
  updates take priority and must not reopen on retries or navigation.
- **Devices.** "My iPad" = iPad Air, "my phone" = iPhone 11. Install with
  `scripts/ios-install.sh` (`--iphone`, `--all`; `--core` after `crates/`
  changes). It prints the build stamp that Settings → About shows. If the user
  says "nothing changed", compare those first.
- **Worksheet drawings.** See the Decisions in Linear PRI-324.
- **Simulators.** Use T3 device tools. Never close or reuse another agent's
  device session; on `DEVICE_IN_USE`, wait or report. Release your own with
  `device_close` when done. Retained simulator ids are in `README.md`.
- Scroll, keyboard or caret changes in the editor need tests; see
  `apps/shared-ui/AGENTS.md`.
