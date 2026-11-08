# memnoter-core

Tauri-free storage and data operations shared by Memnoter's desktop app and
native iOS app through the `memnoter-ffi` UniFFI crate.

Open one `Core::open(data_dir)` for a data directory. It creates/migrates
`main.db`, enables WAL and foreign keys, creates `files/`, settles interrupted
restores, and imports a sibling legacy `com.vladyslavnalyvaiko.notes` directory
when appropriate. Pass an absolute, writable, application-owned directory.
Images have UUID filenames under `files/`; paths are derived from validated IDs.
The legacy absolute `files.path` column remains for older builds. Ordered
migrations use SQLite `user_version`, including unversioned database upgrades.
Backups live in `backups/<timestamp>/` and include both SQLite and images.
Do not independently modify these paths while the core is open.

The `content`, `files`, `cards`, `search`, and `backups` modules expose plain
Rust functions. Command-facing functions take `&core.db` and, where needed,
`core.data_dir()`. Response types retain the desktop serialization shapes.
The `db` module owns the connection, initialization and migrations. Errors
are `String`s (`CommandResult<T>`). Restore can mark the database unavailable;
subsequent operations then require reopening/restarting to recover.

`dispatch(&core, command, args_json) -> Result<String, String>` accepts exactly
the JSON object passed to desktop `invoke(command, args)`: argument keys are
camelCase (`moduleId`, `newState`, `updateId`, `mimeType`, etc.), binary values
are arrays of byte numbers (0–255), and nested card payloads use their existing
Serde shapes. Optional arguments may be omitted or null. Extra object keys are
ignored, as by Tauri. Successful output is the serialized command return value,
including `null` for unit, with existing snake_case response keys. Storage error
strings pass through unchanged; malformed arguments return a deserialization
error. Unknown commands return `Unknown command: <name>`, even for invalid JSON.
`DATA_COMMANDS` is generated from the dispatch entries. A test compares it with
the desktop handler list. Exit/restart and macOS menu commands are desktop-only.

All operations are synchronous and the database uses one mutex-protected
connection. Share an `Arc<Core>` across threads; avoid calling storage directly
on a SwiftUI/main/UI thread. Large content loads, Yjs replay/compaction, image IO,
search indexing, backups (`VACUUM INTO`) and restore may be slow and hold the
connection lock. `backups::spawn_daily_backup(Arc<Core>)` returns a join handle
for one background launch-time check: it creates a snapshot if the persisted
latest backup is at least 24 hours old, matching desktop behavior. It is not a
repeating timer. Callers own thread lifetime and any additional scheduling.

The workspace shares the root `Cargo.lock`. Run `cargo test --workspace` and
`cargo check -p memnoter-core --target aarch64-apple-ios[-sim]` from the repo root.
SQLite is bundled, including FTS5, on desktop and iOS.
