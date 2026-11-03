<p align="center">
  <img src="brand/app-icon.png" width="128" alt="Memnoter icon">
</p>

<h1 align="center">Memnoter</h1>

<p align="center">
  <strong>Notes you write once and remember for good.</strong><br>
  A local-first notes app with spaced-repetition flashcards built into the text.
</p>

<p align="center">
  <a href="https://github.com/princhman/memnoter/releases/latest"><img src="https://img.shields.io/github/v/release/princhman/memnoter?color=432fc8" alt="Latest release"></a>
  <a href="https://github.com/princhman/memnoter/actions/workflows/ci.yml"><img src="https://github.com/princhman/memnoter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

---

Most study workflows split notes from flashcards: you write in one app, then
copy the important bits into Anki. Memnoter removes the copy step. A line like
`Modus ponens :: from A and A → B, infer B` is a normal sentence in your notes,
and it is also a flashcard scheduled with FSRS. Edit the note and the card
changes with it. Everything stays on your machine.

## Features

### Write cards where you write notes

- **Basic cards:** `Question :: answer` on any line or heading.
- **Clozes:** wrap text in `{{…}}`, or select it and press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>C</kbd>.
  Each cloze is its own card, and several clozes can be joined into one.
- **Image occlusion:** draw rectangles, ellipses or freehand masks over a
  diagram. Move and resize them with handles, and join several masks into a
  single card.
- **A dot beside every card** shows whether it is due and when you last
  reviewed it, so you can see what you know while you read.

### Review that respects the schedule

- Scheduling uses [FSRS](https://github.com/open-spaced-repetition/ts-fsrs),
  the algorithm behind modern Anki.
- Review everything, or one module at a time.
- <kbd>Space</kbd> reveals the answer and <kbd>1</kbd> to <kbd>4</kbd> grade it.
  Grades can be undone and redone.
- A card graded Again comes back when it is due, not straight away. The header
  shows new, learning and review counts, with `+n` for cards due later today.
- Each card shows the heading path it comes from, and opens in its note with one click.
- Other clozes and masks stay hidden on the front. Click one for context
  without revealing the answer.

### A focused editor

- Rich text with headings, lists, links, code, highlights and images.
- LaTeX math, inline (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>M</kbd>) or as blocks
  (<kbd>⌘</kbd><kbd>⌥</kbd><kbd>M</kbd>), rendered with KaTeX.
- Foldable sections. Each module reopens where you left it, with the same
  scroll position and folds.
- <kbd>⌘</kbd><kbd>K</kbd> opens one palette that searches module titles, note
  text and math, and also runs commands.

### Your data is yours

- Notes live in a local SQLite database. No account is needed for local use,
  and there is no telemetry.
- Optional [end-to-end encrypted cloud sync](docs/sync.md) keeps notes, images
  and review history up to date across devices. Sign in under Settings > Sync.
- Saves retry in order, and quitting waits for pending saves.
- A daily backup of notes and images keeps the last 7 days. You can also back
  up and restore from Settings.
- The app updates itself in the background from signed GitHub releases.

## Install

Download the latest build from the
[releases page](https://github.com/princhman/memnoter/releases/latest):

| Platform | File |
| --- | --- |
| macOS (Apple silicon) | `Memnoter_<version>_aarch64.dmg` |
| macOS (Intel) | `Memnoter_<version>_x64.dmg` |
| Windows | `.msi` or `-setup.exe` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

After the first install, new versions download automatically. Each one applies
the next time you open the app.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette and search | <kbd>⌘</kbd><kbd>K</kbd> |
| New module | <kbd>⌘</kbd><kbd>N</kbd> |
| Find in note | <kbd>⌘</kbd><kbd>F</kbd> |
| Toggle sidebar | <kbd>⌘</kbd><kbd>D</kbd> |
| Make or remove a cloze | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>C</kbd> |
| Edit link | <kbd>⌘</kbd><kbd>L</kbd> |
| Inline math | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>M</kbd> |
| Math block | <kbd>⌘</kbd><kbd>⌥</kbd><kbd>M</kbd> |
| New section / subsection | <kbd>⌘</kbd><kbd>⌥</kbd><kbd>S</kbd> / <kbd>⌘</kbd><kbd>⌥</kbd><kbd>D</kbd> |
| Reveal answer (review) | <kbd>Space</kbd> |
| Grade Again, Hard, Good, Easy (review) | <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> |

On Windows and Linux, use <kbd>Ctrl</kbd> instead of <kbd>⌘</kbd> and
<kbd>Alt</kbd> instead of <kbd>⌥</kbd>.

## Built with

[Tauri 2](https://tauri.app) and Rust with SQLite on the backend;
[React 19](https://react.dev), [Tiptap](https://tiptap.dev) and
[Yjs](https://yjs.dev) for the editor; [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
for scheduling; [KaTeX](https://katex.org) for math; Tailwind CSS and Base UI
for the interface.

## Development

You need Node 22.6+, [pnpm](https://pnpm.io), a Rust toolchain and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
pnpm install
pnpm tauri dev      # run the app with hot reload
```

Before opening a pull request:

```sh
pnpm test                                          # frontend and integration tests
cargo test --manifest-path src-tauri/Cargo.toml    # Rust tests
pnpm lint                                          # style rules
pnpm build                                         # typecheck and bundle
```

Design notes live in [`docs/`](docs). [`docs/flashcards.md`](docs/flashcards.md)
covers card syntax, card identity, scheduling, image occlusion and how image
files are kept and cleaned up.

## License

The Memnoter app, including the shared sync client and protocol in
`src/lib/sync/`, is licensed under [MIT](LICENSE) © Vladyslav Nalyvaiko.

The server in [`sync-server/`](sync-server/) is licensed separately under
[GNU AGPL-3.0](sync-server/LICENSE). Self-hosting is free; anyone running a
modified copy as a service must publish their changes.

## Native iPad app and shared core

See [apps/ios/README.md](apps/ios/README.md) for the native SwiftUI iPad app and build instructions, and [crates/memnoter-core/README.md](crates/memnoter-core/README.md) for the shared Rust core and dispatch API.
