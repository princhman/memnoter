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

> **Beta:** Memnoter is in beta, so bugs are expected. Please send a report or message to [hello@memnoter.com](mailto:hello@memnoter.com) or [open a GitHub issue](https://github.com/princhman/memnoter/issues).

---

Most study workflows split notes from flashcards: you write in one app, then
copy the important bits into Anki. Memnoter removes the copy step. A line like
`Modus ponens :: from A and A → B, infer B` is a normal sentence in your notes,
and it is also a flashcard scheduled with FSRS. Edit the note and the card
changes with it. Everything stays on your machine.

## Features

### Write cards where you write notes

- **Basic cards:** `Question :: answer` in a paragraph or heading.
- **Two-way cards:** `Front ::: Back` creates forward and reverse basic cards.
  After you review one side, the other waits 10 minutes.
  Separators need whitespace on both sides; `a:::b` and `::::` stay prose.
  Inline code is never card syntax, and clozes take precedence.
  Use Shift+Enter for multiple lines within either side of a card.
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
  shows new, learning and review counts, with `+n` for cards due later today,
  and highlights the count of the card on screen.
- New cards can wait a day: turn on "Skip cards added to this device today" in
  Settings to hold them back until midnight.
- Each card shows the heading path it comes from, and opens in its note with one click.
- Other clozes and masks stay hidden on the front. Click one for context
  without revealing the answer.

### A focused editor

- Rich text with headings, lists, links, code, highlights and images.
- LaTeX math, inline (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>M</kbd>) or as blocks
  (<kbd>⌘</kbd><kbd>⌥</kbd><kbd>M</kbd>), rendered with KaTeX.
- Foldable sections. Each module reopens where you left it, with the same
  scroll position and folds.
- The desktop Contents panel uses compact section actions and a subtle purple
  reading highlight. Hover a row or reach it by keyboard to focus that section;
  its Unfocus control stays visible while focused. Touch controls stay visible.
- <kbd>⌘</kbd><kbd>K</kbd> opens one palette that searches module titles, note
  text and math, and also runs commands.

### On iPad too

- A native iPad app shares the same editor and scheduler, with its own
  formatting bar above the keyboard, a Contents panel and a full review screen.
- Sync keeps notes and review history the same on Mac and iPad.

### Your data is yours

- Notes live in a local SQLite database. No account is needed for local use,
  and there is no telemetry.
- Optional end-to-end encrypted cloud sync keeps notes, images
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

The iPad app ships through TestFlight. To build it yourself, see
[apps/ios/README.md](apps/ios/README.md).

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
| Undo / redo a grade (review) | <kbd>⌘</kbd><kbd>Z</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Z</kbd> |

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
pnpm dev            # run the desktop app with hot reload
```

| Command | Runs |
| --- | --- |
| `pnpm dev` | Desktop app |
| `pnpm dev:ui` | Shared UI in a browser, without native data |
| `pnpm dev:sync` | Sync server on port 8787 |
| `pnpm dev:sync-test` | Sync server and two desktop copies, with throwaway data |
| `pnpm dev:marketing` | Build and serve the marketing site on port 4173 |
| `pnpm dev:ios` | Build the iPad dependencies and open Xcode |
| `pnpm check` | Lint, build and every test |

Before opening a pull request:

```sh
pnpm check
```

## License

The Memnoter app, including the shared sync client and protocol in
`apps/shared-ui/src/lib/sync/`, is licensed under [MIT](LICENSE) © Vladyslav Nalyvaiko.

The server in [`apps/sync/`](apps/sync/) is licensed separately under
[GNU AGPL-3.0](apps/sync/LICENSE). Self-hosting is free; anyone running a
modified copy as a service must publish their changes.

## Native iPad app and shared core

See [apps/ios/README.md](apps/ios/README.md) for the native SwiftUI iPad app and build instructions, and [crates/memnoter-core/README.md](crates/memnoter-core/README.md) for the shared Rust core and dispatch API.


### Import an Obsidian folder (desktop)

Choose **Import folder…** in the new-module dialog, the command palette, or
**File → Import Folder…**. Select the folder itself. Memnoter creates one new
module, shows progress and a summary, then opens it. Existing module names get
a numeric suffix.

The folder's matching hub note comes first. Root notes and nonempty subfolders
become sections, ordered naturally; numeric folder prefixes are hidden in section
titles. Nested notes retain their headings below their section. Markdown tables,
yellow highlights, code and supported local images are preserved. PNG, JPEG,
WebP and GIF files are copied into managed storage; unresolved images become
readable placeholders. PDFs, text exports and other files are listed in the
summary and are not imported. Hidden folders and symbolic links are skipped.
The source folder is read-only; a failed import removes its partial module.

Importer tests use a synthetic folder. Real-folder verification runs when the
local COMP0002 folder exists, or when `MEMNOTER_IMPORT_FOLDER` points to it.
No source notes or attachments are stored in this repository.
