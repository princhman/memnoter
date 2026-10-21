# Notes

A local notes app built with Tauri, React, and TipTap.

Deleted images remain on disk during the app session so Undo/Redo can restore
them. After restarting the app, the first time each note is opened, unused image
files and their database records are removed. Images still referenced anywhere
in that note are retained. Cleanup skips changed or incomplete saved content;
failed disk removals keep their records for retry on a later launch.

Run `pnpm test` (Node 22.6+), `cargo test --manifest-path src-tauri/Cargo.toml`,
and `pnpm build` to check image cleanup and compile the app.

Notes restore their snapshot and edit history in one Yjs transaction. The same
document is used for startup image cleanup, and local saves keep the query
cache current without rereading the note on window focus. Formula indexes
rescan changed ranges. Formula rendering and image loading are deferred until
near the viewport; rendered formulas retain their DOM when scrolling away.
