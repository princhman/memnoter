# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

Deleted images remain on disk during the app session so Undo/Redo can restore
them. After restarting the app, the first time each note is opened, unused image
files and their database records are removed. Images still referenced anywhere
in that note are retained. Cleanup skips changed or incomplete saved content;
failed disk removals keep their records for retry on a later launch.

Run `pnpm test` (Node 22.6+), `cargo test --manifest-path src-tauri/Cargo.toml`,
and `pnpm build` to check image cleanup and compile the app.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
