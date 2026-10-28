// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod backups;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use uuid::Uuid;

mod cards;
use cards::migrate_flashcards;
#[cfg(target_os = "macos")]
mod menu;

type CommandResult<T> = std::result::Result<T, String>;

struct Db {
    conn: Mutex<Connection>,
    unavailable: AtomicBool,
}

impl Db {
    fn lock(&self) -> CommandResult<std::sync::MutexGuard<'_, Connection>> {
        let conn = self.conn.lock().map_err(db_err)?;
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Database unavailable. Restart the app to recover.".into());
        }
        Ok(conn)
    }
}

#[derive(Default)]
struct ExitGate(AtomicBool);
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    app.state::<ExitGate>().0.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[derive(Debug, serde::Serialize)]
struct Module {
    id: String,
    name: String,
}

#[derive(Debug, serde::Serialize)]
struct ContentUpdate {
    id: i64,
    bytes: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
struct FileType {
    id: String,
    path: String,
    file_type: String,
}

#[derive(Debug, serde::Serialize)]
struct FileContents {
    bytes: Vec<u8>,
    file_type: String,
}

#[derive(Debug, serde::Serialize)]
struct GetContentResponse {
    state: Vec<u8>,
    updates: Vec<ContentUpdate>,
    files: Vec<FileType>,
}

fn db_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// Data dir name used before the app was renamed to memnoter.
const LEGACY_IDENTIFIER: &str = "com.vladyslavnalyvaiko.notes";

fn init_db(app: &tauri::App) -> CommandResult<Db> {
    let app_dir = app.path().app_data_dir().map_err(db_err)?;
    initialize_data(&app_dir)
}

fn initialize_data(app_dir: &Path) -> CommandResult<Db> {
    backups::settle_restore(app_dir)?;
    migrate_legacy_data(app_dir)?;
    open_db(app_dir)
}

// One-time copy of the pre-rename data dir into the new one. The legacy dir is
// never modified, so it stays as a backup. main.db is moved in last: its
// presence marks the migration as complete, so an interrupted run just retries.
fn migrate_legacy_data(app_dir: &Path) -> CommandResult<()> {
    if app_dir.join("main.db").exists() {
        return Ok(());
    }
    let Some(parent) = app_dir.parent() else {
        return Ok(());
    };
    let legacy_dir = parent.join(LEGACY_IDENTIFIER);
    if legacy_dir == app_dir || !legacy_dir.join("main.db").exists() {
        return Ok(());
    }

    let staging_dir = parent.join(format!(
        "{}.migrating",
        app_dir.file_name().unwrap_or_default().to_string_lossy()
    ));
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir).map_err(db_err)?;
    }
    copy_dir(&legacy_dir, &staging_dir)?;
    rewrite_file_paths(&staging_dir.join("main.db"), &app_dir.join("files"))?;

    std::fs::create_dir_all(app_dir).map_err(db_err)?;
    let mut entries = std::fs::read_dir(&staging_dir)
        .map_err(db_err)?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(db_err)?;
    entries.sort_by_key(|entry| entry.file_name() == "main.db");
    for entry in entries {
        let target = app_dir.join(entry.file_name());
        if target.is_dir() {
            std::fs::remove_dir_all(&target).map_err(db_err)?;
        } else if target.exists() {
            std::fs::remove_file(&target).map_err(db_err)?;
        }
        std::fs::rename(entry.path(), &target).map_err(db_err)?;
    }
    std::fs::remove_dir_all(&staging_dir).map_err(db_err)
}

fn copy_dir(from: &Path, to: &Path) -> CommandResult<()> {
    std::fs::create_dir_all(to).map_err(db_err)?;
    for entry in std::fs::read_dir(from).map_err(db_err)? {
        let entry = entry.map_err(db_err)?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(db_err)?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(db_err)?;
        }
    }
    Ok(())
}

// Stored file paths are absolute, so point them at the new files dir and fold
// the WAL into main.db so the moved database is self-contained.
fn rewrite_file_paths(db_path: &Path, files_dir: &Path) -> CommandResult<()> {
    let mut conn = Connection::open(db_path).map_err(db_err)?;
    let tx = conn.transaction().map_err(db_err)?;
    let ids = tx
        .prepare("select id from files")
        .map_err(db_err)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)?;
    for id in ids {
        let path = files_dir.join(&id);
        let path_str = path
            .to_str()
            .ok_or_else(|| "File path is not valid UTF-8".to_string())?;
        tx.execute(
            "update files set path = ?1 where id = ?2",
            params![path_str, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(db_err)?;
    conn.close().map_err(|(_, error)| db_err(error))
}

// AUTOINCREMENT preserves the high-water mark even after compaction empties
// the table. A stale read must never authorize deleting a newly reused id.
fn migrate_update_ids(conn: &Connection) -> CommandResult<()> {
    let schema: String = conn
        .query_row(
            "select sql from sqlite_master where type = 'table' and name = 'contents_updates'",
            [],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if schema.to_uppercase().contains("AUTOINCREMENT") {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    tx.execute_batch(
        "create table contents_updates_monotonic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
    );
    insert into contents_updates_monotonic select * from contents_updates;
    drop table contents_updates;
    alter table contents_updates_monotonic rename to contents_updates;",
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn open_db(app_dir: &Path) -> CommandResult<Db> {
    std::fs::create_dir_all(app_dir).map_err(db_err)?;

    let db_path = app_dir.join("main.db");
    let conn = Connection::open(&db_path).map_err(db_err)?;

    let files_path = app_dir.join("files");
    std::fs::create_dir_all(&files_path).map_err(db_err)?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        create table if not exists modules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        create table if not exists contents (
            module_id TEXT PRIMARY KEY,
            state BLOB NOT NULL,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        create table if not exists contents_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id TEXT NOT NULL,
            bytes BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        create table if not exists files (
            id TEXT PRIMARY KEY,
            module_id TEXT NOT NULL,
            path TEXT NOT NULL,
            file_type TEXT NOT NULL
        )",
    )
    .map_err(db_err)?;
    migrate_flashcards(&conn)?;
    migrate_search(&conn)?;

    migrate_update_ids(&conn)?;

    Ok(Db {
        conn: Mutex::new(conn),
        unavailable: AtomicBool::new(false),
    })
}

// Full-text search over every module: one row per module, with its title, the
// plain text of the note and the LaTeX source of its formulas. unicode61 with
// remove_diacritics folds case and accents; the prefix index keeps type-ahead
// queries ("integ*") fast. search_index_state records which extractor version
// produced each row, so the frontend can re-index after the extractor changes.
fn migrate_search(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "
        create virtual table if not exists search_index using fts5(
            module_id UNINDEXED,
            title,
            body,
            math,
            tokenize = 'unicode61 remove_diacritics 2',
            prefix = '2 3'
        );

        create table if not exists search_index_state (
            module_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        -- Titles are known up front, so modules from before the index existed
        -- are searchable by name straight away; their text is backfilled later.
        delete from search_index
            where module_id not in (select id from modules);
        insert into search_index (module_id, title, body, math)
            select id, name, '', '' from modules
            where id not in (select module_id from search_index);",
    )
    .map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: std::path::PathBuf,
        db: Db,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("notes-cleanup-{}", Uuid::new_v4()));
            let db = open_db(&dir).unwrap();
            {
                let conn = db.conn.lock().unwrap();
                conn.execute_batch(
                    "insert into modules values ('note', 'Note'), ('other', 'Other');
                     insert into contents values ('note', X'01'), ('other', X'02');
                     insert into contents_updates values (7, 'note', X'03', 0);",
                )
                .unwrap();
            }
            Self { dir, db }
        }

        fn file(&self, module: &str) -> String {
            let id = Uuid::new_v4().to_string();
            let path = self.dir.join("files").join(&id);
            std::fs::write(&path, b"image bytes").unwrap();
            self.db
                .conn
                .lock()
                .unwrap()
                .execute(
                    "insert into files values (?1, ?2, ?3, 'image/png')",
                    params![id, module, path.to_str().unwrap()],
                )
                .unwrap();
            id
        }

        fn cleanup(&self, ids: &[String], state: &[u8], update_id: i64) -> Vec<String> {
            cleanup_unused_files(
                &self.db.conn.lock().unwrap(),
                &self.dir.join("files"),
                "note",
                ids,
                state,
                update_id,
            )
            .unwrap()
        }

        fn row_exists(&self, id: &str) -> bool {
            self.db
                .conn
                .lock()
                .unwrap()
                .query_one(
                    "select exists(select 1 from files where id = ?1)",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn deleting_module_removes_its_data_and_images_but_preserves_other_modules() {
        let f = Fixture::new();
        let image = f.file("note");
        let missing_image = f.file("note");
        let other_image = f.file("other");
        let files_dir = f.dir.join("files");
        std::fs::remove_file(files_dir.join(&missing_image)).unwrap();

        let mut conn = f.db.conn.lock().unwrap();
        delete_module_data(&mut conn, &files_dir, "note").unwrap();
        for table in ["contents", "contents_updates", "files"] {
            let count: i64 = conn
                .query_one(
                    &format!("select count(*) from {table} where module_id = 'note'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "{table} retained deleted module data");
        }
        let modules: Vec<String> = conn
            .prepare("select id from modules")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap();
        assert_eq!(modules, vec!["other"]);
        let other_state: Vec<u8> = conn
            .query_one(
                "select state from contents where module_id = 'other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other_state, vec![2]);
        drop(conn);
        assert!(!files_dir.join(image).exists());
        assert!(files_dir.join(&other_image).exists());
        assert!(f.row_exists(&other_image));
    }

    #[test]
    fn cleanup_removes_only_requested_files_owned_by_the_note() {
        let f = Fixture::new();
        let unused = f.file("note");
        let retained = f.file("note");
        let other = f.file("other");
        assert_eq!(
            f.cleanup(&[unused.clone(), other.clone()], &[1], 7),
            vec![unused.clone()]
        );
        assert!(!f.row_exists(&unused));
        assert!(!f.dir.join("files").join(&unused).exists());
        for id in [&retained, &other] {
            assert!(f.row_exists(id));
            assert_eq!(
                std::fs::read(f.dir.join("files").join(id)).unwrap(),
                b"image bytes"
            );
        }
        assert!(f.cleanup(&[unused], &[1], 7).is_empty());
    }

    #[test]
    fn stale_snapshots_never_remove_files() {
        let f = Fixture::new();
        let id = f.file("note");
        for (state, update_id) in [(vec![0], 7), (vec![1], 6)] {
            assert!(f
                .cleanup(std::slice::from_ref(&id), &state, update_id)
                .is_empty());
            assert!(f.row_exists(&id));
            assert!(f.dir.join("files").join(&id).exists());
        }
    }

    #[test]
    fn failed_removals_remain_retryable_and_missing_files_are_cleaned_up() {
        let f = Fixture::new();
        let id = f.file("note");
        let path = f.dir.join("files").join(&id);
        std::fs::remove_file(&path).unwrap();
        // A directory at the file path reliably fails remove_file, even as root.
        std::fs::create_dir(&path).unwrap();
        assert!(f.cleanup(std::slice::from_ref(&id), &[1], 7).is_empty());
        assert!(f.row_exists(&id));
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(
            f.cleanup(std::slice::from_ref(&id), &[1], 7),
            vec![id.clone()]
        );
        assert!(!f.row_exists(&id));
    }

    fn search_ids(conn: &Connection, query: &str) -> Vec<String> {
        search(conn, query, 20)
            .unwrap()
            .into_iter()
            .map(|result| result.module_id)
            .collect()
    }

    #[test]
    fn search_query_quotes_terms_and_prefixes_the_last() {
        assert_eq!(fts_query("foo bar").as_deref(), Some("\"foo\" \"bar\"*"));
        assert_eq!(
            fts_query(r#"say "hi""#).as_deref(),
            Some(r#""say" """hi"""*"#)
        );
        assert_eq!(fts_query("  \t\n "), None);
        assert_eq!(fts_query(r#"" - ( ) * ^ :"#), None);
    }

    #[test]
    fn search_ranks_titles_first_and_marks_matches() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        index_note_text(&mut conn, "note", "about the integral sign", "", 1, false).unwrap();
        index_note_text(
            &mut conn,
            "other",
            "nothing here",
            r"\int_0^1 f(x)\,dx",
            1,
            false,
        )
        .unwrap();
        conn.execute(
            "update search_index set title = 'Integrals' where module_id = 'other'",
            [],
        )
        .unwrap();

        let results = search(&conn, "integ", 10).unwrap();
        let ids: Vec<_> = results.iter().map(|r| r.module_id.as_str()).collect();
        assert_eq!(ids, ["other", "note"]);
        assert_eq!(results[0].name_marked, "\u{2}Integrals\u{3}");
        assert!(results[1].snippet.contains("\u{2}integral\u{3}"));

        // LaTeX source is searchable, and the snippet comes from the math column.
        let results = search(&conn, r"\int_0", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].snippet, "\\\u{2}int_0\u{3}^1 f(x)\\,dx");
        // Every term must match.
        assert_eq!(search_ids(&conn, "integral nothing"), Vec::<String>::new());
        // Diacritics and case are folded.
        assert_eq!(search_ids(&conn, "ÍNTEGRAL SÍGN"), ["note"]);
    }

    #[test]
    fn search_never_fails_on_fts_syntax() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        index_note_text(
            &mut conn,
            "note",
            "and or not near title body",
            "",
            1,
            false,
        )
        .unwrap();
        for query in [
            "\"",
            "\"\"",
            "-",
            "-foo",
            "AND",
            "foo AND",
            "OR NOT",
            "(",
            ")",
            "(foo",
            "*",
            "foo*",
            "^",
            "title:",
            "title:foo",
            "NEAR(a b)",
            "{title body}: x",
            "a + b",
            "'",
            "\\",
            "\u{0}",
            "😀",
            "a\"b",
            "and",
            "not",
            "x OR",
            "",
        ] {
            assert!(search(&conn, query, 10).is_ok(), "query {query:?} failed");
        }
        assert_eq!(search_ids(&conn, "AND"), ["note"]);
        assert_eq!(search_ids(&conn, "near"), ["note"]);
        // A column filter is literal text, not a filter.
        assert_eq!(search_ids(&conn, "title:"), ["note"]);
    }

    #[test]
    fn search_index_follows_module_lifecycle() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        // Modules that existed before the index are searchable by title once
        // the app restarts.
        assert_eq!(search_ids(&conn, "Note"), Vec::<String>::new());
        migrate_search(&conn).unwrap();
        migrate_search(&conn).unwrap();
        assert_eq!(search_ids(&conn, "Note"), ["note"]);

        index_note_text(&mut conn, "note", "first", "", 1, false).unwrap();
        index_note_text(&mut conn, "note", "second", "", 2, false).unwrap();
        assert_eq!(search_ids(&conn, "first"), Vec::<String>::new());
        assert_eq!(search_ids(&conn, "second"), ["note"]);
        // A delayed backfill read must not replace a newer live index write.
        index_note_text(&mut conn, "note", "stale", "", 2, true).unwrap();
        assert_eq!(search_ids(&conn, "second"), ["note"]);
        assert!(search_ids(&conn, "stale").is_empty());
        // An extractor upgrade can still backfill an older index.
        index_note_text(&mut conn, "note", "second upgraded", "", 3, true).unwrap();
        assert_eq!(search_ids(&conn, "upgraded"), ["note"]);
        let rows: i64 = conn
            .query_one(
                "select count(*) from search_index where module_id = 'note'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);

        delete_module_data(&mut conn, &f.dir.join("files"), "note").unwrap();
        assert_eq!(search_ids(&conn, "second"), Vec::<String>::new());
        let states: i64 = conn
            .query_one("select count(*) from search_index_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(states, 0);

        // A late save for a deleted module must not bring it back.
        index_note_text(&mut conn, "note", "revived", "", 1, false).unwrap();
        assert_eq!(search_ids(&conn, "revived"), Vec::<String>::new());
    }

    #[test]
    fn compaction_writes_state_and_drops_updates_together() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        conn.execute_batch("insert into contents_updates values (8, 'note', X'04', 0);")
            .unwrap();
        compact_content(&mut conn, "note", &[9], 7).unwrap();
        let content = read_content(&conn, "note").unwrap();
        assert_eq!(content.state, vec![9]);
        assert_eq!(
            content
                .updates
                .iter()
                .map(|update| update.id)
                .collect::<Vec<_>>(),
            vec![8]
        );
    }

    #[test]
    fn legacy_update_id_migration_preserves_rows_and_their_high_watermark() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
            create table modules (id TEXT PRIMARY KEY);
            insert into modules values ('note');
            create table contents_updates (id INTEGER PRIMARY KEY, module_id TEXT NOT NULL,
                bytes BLOB NOT NULL, created_at INTEGER NOT NULL,
                FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE);
            insert into contents_updates values (300, 'note', X'0102', 42);",
        )
        .unwrap();
        migrate_update_ids(&conn).unwrap();
        migrate_update_ids(&conn).unwrap();
        let row: (i64, Vec<u8>, i64) = conn
            .query_row(
                "select id, bytes, created_at from contents_updates",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (300, vec![1, 2], 42));
        conn.execute("delete from contents_updates", []).unwrap();
        conn.execute("insert into contents_updates (module_id, bytes, created_at) values ('note', X'03', 43)", []).unwrap();
        assert_eq!(conn.last_insert_rowid(), 301);
        conn.execute("delete from modules where id = 'note'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("select count(*) from contents_updates", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn stale_compaction_watermark_cannot_delete_a_later_update() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        // A stale read can retain the old watermark after its rows are folded.
        compact_content(&mut conn, "note", &[9], 7).unwrap();
        conn.execute(
            "insert into contents_updates (module_id, bytes, created_at) values ('note', X'05', 0)",
            [],
        )
        .unwrap();
        compact_content(&mut conn, "note", &[9], 7).unwrap();
        let content = read_content(&conn, "note").unwrap();
        assert_eq!(content.updates.len(), 1);
        assert_eq!(content.updates[0].bytes, vec![5]);
        assert!(content.updates[0].id > 7);
    }

    #[test]
    fn failed_compaction_leaves_content_unchanged() {
        let f = Fixture::new();
        let mut conn = f.db.conn.lock().unwrap();
        let before = serde_json::to_value(read_content(&conn, "note").unwrap()).unwrap();
        // Fail the second statement, after the state has already been written.
        conn.execute_batch(
            "create temp trigger fail_delete before delete on contents_updates
             begin select raise(abort, 'disk full'); end;",
        )
        .unwrap();
        assert!(compact_content(&mut conn, "note", &[9], 7).is_err());
        conn.execute_batch("drop trigger fail_delete;").unwrap();
        let after = serde_json::to_value(read_content(&conn, "note").unwrap()).unwrap();
        assert_eq!(after, before);
        assert_eq!(after["state"], serde_json::json!([1]));
    }

    #[test]
    fn legacy_data_is_copied_with_rewritten_paths_and_left_intact() {
        let root = std::env::temp_dir().join(format!("notes-migrate-{}", Uuid::new_v4()));
        let legacy = Fixture {
            dir: root.join(LEGACY_IDENTIFIER),
            db: open_db(&root.join(LEGACY_IDENTIFIER)).unwrap(),
        };
        legacy
            .db
            .conn
            .lock()
            .unwrap()
            .execute_batch("insert into modules values ('note', 'Note');")
            .unwrap();
        // Keep the legacy connection open so its writes are still in the WAL.
        let id = legacy.file("note");

        let app_dir = root.join("com.vladyslavnalyvaiko.memnoter");
        migrate_legacy_data(&app_dir).unwrap();

        let db = open_db(&app_dir).unwrap();
        let path: String = db
            .conn
            .lock()
            .unwrap()
            .query_one("select path from files where id = ?1", [&id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(Path::new(&path), app_dir.join("files").join(&id));
        assert_eq!(std::fs::read(&path).unwrap(), b"image bytes");
        assert!(legacy.dir.join("files").join(&id).exists());
        assert!(!root
            .join("com.vladyslavnalyvaiko.memnoter.migrating")
            .exists());

        // Already migrated: a second run must not overwrite newer data.
        db.conn
            .lock()
            .unwrap()
            .execute("delete from files", [])
            .unwrap();
        migrate_legacy_data(&app_dir).unwrap();
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_one("select count(*) from files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[tauri::command]
fn create_module(db: tauri::State<Db>, name: String) -> CommandResult<String> {
    let conn = db.lock()?;
    let id = Uuid::new_v4().to_string();

    conn.execute(
        "insert into modules (id, name)
             values (?1, ?2)",
        params![id, name],
    )
    .map_err(db_err)?;

    conn.execute(
        "insert into contents (module_id, state)
             values (?1, ?2)",
        params![id, Vec::<u8>::new()],
    )
    .map_err(db_err)?;

    conn.execute(
        "insert into search_index (module_id, title, body, math)
             values (?1, ?2, '', '')",
        params![id, name],
    )
    .map_err(db_err)?;

    Ok(id)
}

#[tauri::command]
fn modules(db: tauri::State<Db>) -> CommandResult<Vec<Module>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare("select * from modules").map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Module {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(db_err)?;

    let modules = rows.collect::<Result<Vec<Module>>>().map_err(db_err)?;

    Ok(modules)
}

#[tauri::command]
fn rename_module(db: tauri::State<Db>, module_id: String, name: String) -> CommandResult<()> {
    let conn = db.lock()?;

    conn.execute(
        "update modules set name = ?2 where id = ?1",
        params![&module_id, &name],
    )
    .map_err(db_err)?;

    conn.execute(
        "update search_index set title = ?2 where module_id = ?1",
        params![&module_id, &name],
    )
    .map_err(db_err)?;

    Ok(())
}

fn delete_module_data(
    conn: &mut Connection,
    files_dir: &Path,
    module_id: &str,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let files = {
        let mut stmt = tx
            .prepare("select id, path from files where module_id = ?1")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([module_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>>>().map_err(db_err)?
    };
    for (id, path) in &files {
        if Uuid::parse_str(id).is_err() || Path::new(path) != files_dir.join(id) {
            return Err("Refusing to delete a file outside managed storage".into());
        }
    }
    tx.execute("delete from files where module_id = ?1", [module_id])
        .map_err(db_err)?;
    tx.execute("delete from search_index where module_id = ?1", [module_id])
        .map_err(db_err)?;
    // Foreign keys cascade to the document snapshot and all pending updates.
    tx.execute("delete from modules where id = ?1", [module_id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;

    for (_, path) in files {
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                // The module is already deleted; report disk cleanup separately.
                eprintln!("Failed to remove deleted module image {path}: {error}");
            }
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn delete_module(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    module_id: String,
) -> CommandResult<()> {
    let files_dir = app.path().app_data_dir().map_err(db_err)?.join("files");
    let mut conn = db.lock()?;
    delete_module_data(&mut conn, &files_dir, &module_id)
}

// Reading and serializing a long edit history must not block the native UI.
#[tauri::command(async)]
fn get_content(db: tauri::State<Db>, module_id: String) -> CommandResult<GetContentResponse> {
    let conn = db.lock()?;
    read_content(&conn, &module_id)
}

fn read_content(conn: &Connection, module_id: &str) -> CommandResult<GetContentResponse> {
    let state = conn
        .query_one(
            "select state from contents where module_id = ?1",
            params![&module_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(db_err)?;

    let mut stmt = conn
        .prepare("select id, bytes from contents_updates where module_id = ?1 order by id asc")
        .map_err(db_err)?;

    let updates = stmt
        .query_map(params![&module_id], |row| {
            Ok(ContentUpdate {
                id: row.get(0)?,
                bytes: row.get(1)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<ContentUpdate>>>()
        .map_err(db_err)?;

    let mut files_stmt = conn
        .prepare("select id, path, file_type from files where module_id = ?1")
        .map_err(db_err)?;

    let files = files_stmt
        .query_map(params![&module_id], |row| {
            Ok(FileType {
                id: row.get(0)?,
                path: row.get(1)?,
                file_type: row.get(2)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<FileType>>>()
        .map_err(db_err)?;

    Ok(GetContentResponse {
        state,
        updates,
        files,
    })
}

// Editing emits a save for every Yjs update. Keep the database lock and disk
// write off the native UI thread so rapid input can continue while it saves.
#[tauri::command(async)]
fn add_update(
    db: tauri::State<Db>,
    module_id: String,
    bytes: Vec<u8>,
) -> CommandResult<ContentUpdate> {
    let conn = db.lock()?;

    conn.execute(
        "insert into contents_updates (module_id, bytes, created_at) values (?1, ?2, ?3)",
        params![module_id, bytes, Utc::now().timestamp_millis()],
    )
    .map_err(db_err)?;

    Ok(ContentUpdate {
        id: conn.last_insert_rowid(),
        bytes,
    })
}

#[tauri::command(async)]
fn save_compaction(
    db: tauri::State<Db>,
    module_id: String,
    new_state: Vec<u8>,
    update_id: i64,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    compact_content(&mut conn, &module_id, &new_state, update_id)
}

// The new state already contains the folded updates. Writing it and dropping
// them must happen together, or a failure in between would lose or duplicate
// history.
fn compact_content(
    conn: &mut Connection,
    module_id: &str,
    new_state: &[u8],
    update_id: i64,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;

    tx.execute(
        "update contents set state = ?1 where module_id = ?2",
        params![new_state, module_id],
    )
    .map_err(db_err)?;

    tx.execute(
        "delete from contents_updates where module_id = ?1 and id <= ?2",
        params![module_id, update_id],
    )
    .map_err(db_err)?;

    tx.commit().map_err(db_err)
}

#[tauri::command(async)]
fn save_file(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    module_id: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> CommandResult<FileType> {
    let id = Uuid::new_v4().to_string();
    let app_dir = app.path().app_data_dir().map_err(db_err)?;
    let path = app_dir.join("files").join(&id);

    let path_str = path
        .to_str()
        .ok_or_else(|| "File path is not valid UTF-8".to_string())?;

    let conn = db.lock()?;
    // Serialize uploads with deletion so a pending paste cannot recreate files
    // for a module that has already been removed.
    conn.query_one(
        "select id from modules where id = ?1",
        [&module_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(db_err)?;

    std::fs::write(&path, &bytes).map_err(db_err)?;

    // ai-suggested error handling - cleanup if failed
    if let Err(error) = conn.execute(
        "insert into files (id, module_id, path, file_type)
         values (?1, ?2, ?3, ?4)",
        params![id, module_id, path_str, mime_type],
    ) {
        if let Err(cleanup_error) = std::fs::remove_file(&path) {
            return Err(format!(
                "Database insert failed: {error}. \
                 File cleanup also failed: {cleanup_error}"
            ));
        }

        return Err(db_err(error));
    }

    Ok(FileType {
        id,
        path: path_str.to_owned(),
        file_type: mime_type,
    })
}

#[tauri::command(async)]
fn read_file(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    module_id: String,
    file_id: String,
) -> CommandResult<FileContents> {
    if Uuid::parse_str(&file_id).is_err() {
        return Err("Invalid file ID".to_string());
    }

    let expected_path = app
        .path()
        .app_data_dir()
        .map_err(db_err)?
        .join("files")
        .join(&file_id);
    let conn = db.lock()?;
    let (path, file_type): (String, String) = conn
        .query_row(
            "select path, file_type from files where id = ?1 and module_id = ?2",
            params![file_id, module_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;

    if Path::new(&path) != expected_path.as_path() {
        return Err("Stored image path is invalid".to_string());
    }

    let bytes = std::fs::read(expected_path).map_err(db_err)?;
    Ok(FileContents { bytes, file_type })
}

// The caller reconstructs the persisted Yjs document before supplying unused
// IDs. Keep the connection locked through the revision check and deletion so
// a concurrent save cannot turn that snapshot into a stale cleanup decision.
fn cleanup_unused_files(
    conn: &Connection,
    files_dir: &Path,
    module_id: &str,
    file_ids: &[String],
    expected_state: &[u8],
    expected_update_id: i64,
) -> CommandResult<Vec<String>> {
    let (state, update_id): (Vec<u8>, i64) = conn
        .query_one(
            "select state, coalesce((select max(id) from contents_updates
             where module_id = ?1), 0) from contents where module_id = ?1",
            [module_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;
    if state != expected_state || update_id != expected_update_id {
        return Ok(Vec::new());
    }

    let mut deleted = Vec::new();
    for id in file_ids {
        let path: Option<String> = conn
            .query_row(
                "select path from files where id = ?1 and module_id = ?2",
                params![id, module_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(path) = path else { continue };
        // Only remove files created by save_file, inside the managed directory.
        if Uuid::parse_str(id).is_err() || Path::new(&path) != files_dir.join(id) {
            return Err("Refusing to clean up a file outside managed storage".into());
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                // Keep its row so the disk removal can be retried next launch.
                eprintln!("Failed to remove unused image {id}: {error}");
                continue;
            }
        }
        conn.execute(
            "delete from files where id = ?1 and module_id = ?2",
            params![id, module_id],
        )
        .map_err(db_err)?;
        deleted.push(id.clone());
    }
    Ok(deleted)
}

#[tauri::command(async)]
fn cleanup_files(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    module_id: String,
    file_ids: Vec<String>,
    expected_state: Vec<u8>,
    expected_update_id: i64,
) -> CommandResult<Vec<String>> {
    let files_dir = app.path().app_data_dir().map_err(db_err)?.join("files");
    let conn = db.lock()?;
    cleanup_unused_files(
        &conn,
        &files_dir,
        &module_id,
        &file_ids,
        &expected_state,
        expected_update_id,
    )
}

#[derive(Debug, serde::Serialize)]
struct SearchResult {
    module_id: String,
    name: String,
    // The name and a short excerpt, with each match wrapped in
    // SNIPPET_START and SNIPPET_END.
    name_marked: String,
    snippet: String,
}

const SNIPPET_START: &str = "\u{2}";
const SNIPPET_END: &str = "\u{3}";
const MAX_QUERY_TERMS: usize = 16;

// Turns free text into an FTS5 query that cannot be a syntax error: every
// whitespace-separated term becomes a quoted string, so operators, quotes,
// parentheses and column filters are matched as text. Terms are ANDed, and the
// last one is a prefix so results follow typing. Terms without any letter or
// digit produce no tokens, so they are dropped rather than matching nothing.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .take(MAX_QUERY_TERMS)
        .map(|term| {
            let clean: String = term.chars().filter(|c| !c.is_control()).collect();
            format!("\"{}\"", clean.replace('"', "\"\""))
        })
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{}*", terms.join(" ")))
}

fn index_note_text(
    conn: &mut Connection,
    module_id: &str,
    body: &str,
    math: &str,
    version: i64,
    backfill: bool,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    // Backfill may have read its snapshot before a live index write. Never
    // replace an index already refreshed by this extractor (or a newer one).
    if backfill && tx.query_row(
        "select exists(select 1 from search_index_state where module_id = ?1 and version >= ?2)",
        params![module_id, version], |row| row.get::<_, bool>(0),
    ).map_err(db_err)? {
        return Ok(());
    }
    // A debounced save can land after the module was deleted; never revive it.
    let Some(name) = tx
        .query_row(
            "select name from modules where id = ?1",
            [module_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_err)?
    else {
        return Ok(());
    };
    tx.execute("delete from search_index where module_id = ?1", [module_id])
        .map_err(db_err)?;
    tx.execute(
        "insert into search_index (module_id, title, body, math) values (?1, ?2, ?3, ?4)",
        params![module_id, name, body, math],
    )
    .map_err(db_err)?;
    tx.execute(
        "insert into search_index_state (module_id, version) values (?1, ?2)
         on conflict(module_id) do update set version = excluded.version",
        params![module_id, version],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn search(conn: &Connection, query: &str, limit: i64) -> CommandResult<Vec<SearchResult>> {
    let Some(query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    // bm25 weights follow the column order: module_id, title, body, math.
    let mut stmt = conn
        .prepare(
            "select module_id, title,
                 highlight(search_index, 1, ?3, ?4),
                 snippet(search_index, 2, ?3, ?4, '…', 12),
                 snippet(search_index, 3, ?3, ?4, '…', 12)
             from search_index
             where search_index match ?1
             order by bm25(search_index, 0.0, 10.0, 1.0, 1.0)
             limit ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(
            params![query, limit.clamp(1, 100), SNIPPET_START, SNIPPET_END],
            |row| {
                let body: String = row.get(3)?;
                let math: String = row.get(4)?;
                // Show the column that matched; a title-only match shows the
                // start of the note.
                let snippet = if !body.contains(SNIPPET_START) && math.contains(SNIPPET_START) {
                    math
                } else {
                    body
                };
                Ok(SearchResult {
                    module_id: row.get(0)?,
                    name: row.get(1)?,
                    name_marked: row.get(2)?,
                    snippet,
                })
            },
        )
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

#[tauri::command(async)]
fn index_note(
    db: tauri::State<Db>,
    module_id: String,
    body: String,
    math: String,
    version: i64,
    backfill: bool,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    index_note_text(&mut conn, &module_id, &body, &math, version, backfill)
}

// Modules whose text was never indexed, or indexed by an older extractor.
#[tauri::command(async)]
fn unindexed_modules(db: tauri::State<Db>, version: i64) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(
            "select m.id from modules m
             left join search_index_state s on s.module_id = m.id
             where s.version is null or s.version < ?1",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([version], |row| row.get(0))
        .map_err(db_err)?;
    rows.collect::<Result<Vec<String>>>().map_err(db_err)
}

#[tauri::command(async)]
fn search_notes(
    db: tauri::State<Db>,
    query: String,
    limit: i64,
) -> CommandResult<Vec<SearchResult>> {
    let conn = db.lock()?;
    search(&conn, &query, limit)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle_event);

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = init_db(app).expect("Failed to init db.");
            app.manage(db);
            app.manage(ExitGate::default());
            backups::spawn_daily_backup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            menu::set_editor_history,
            confirm_exit,
            create_module,
            modules,
            get_content,
            add_update,
            rename_module,
            delete_module,
            save_compaction,
            save_file,
            read_file,
            cleanup_files,
            cards::sync_cards,
            cards::unindexed_card_modules,
            cards::due_cards,
            cards::due_counts,
            cards::review_card,
            index_note,
            unindexed_modules,
            search_notes,
            backups::list_backups,
            backups::backup_now,
            backups::restore_backup
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitGate>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Err(error) = app.emit("request-safe-exit", ()) {
                        eprintln!("Unable to request safe exit: {error}");
                    }
                }
            }
        });
}
