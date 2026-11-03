use crate::*;
pub struct Db {
    pub(crate) conn: Mutex<Connection>,
    pub(crate) unavailable: AtomicBool,
}

impl Db {
    pub fn lock(&self) -> CommandResult<std::sync::MutexGuard<'_, Connection>> {
        let conn = self.conn.lock().map_err(db_err)?;
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Database unavailable. Restart the app to recover.".into());
        }
        Ok(conn)
    }
}

pub(crate) fn db_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

// Data dir name used before the app was renamed to memnoter.
pub(crate) const LEGACY_IDENTIFIER: &str = "com.vladyslavnalyvaiko.notes";

pub(crate) fn initialize_data(app_dir: &Path) -> CommandResult<Db> {
    backups::settle_restore(app_dir)?;
    migrate_legacy_data(app_dir)?;
    open_db(app_dir)
}

// One-time copy of the pre-rename data dir into the new one. The legacy dir is
// never modified, so it stays as a backup. main.db is moved in last: its
// presence marks the migration as complete, so an interrupted run just retries.
pub(crate) fn migrate_legacy_data(app_dir: &Path) -> CommandResult<()> {
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

pub(crate) fn copy_dir(from: &Path, to: &Path) -> CommandResult<()> {
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
pub(crate) fn rewrite_file_paths(db_path: &Path, files_dir: &Path) -> CommandResult<()> {
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
pub(crate) fn migrate_update_ids(conn: &Connection) -> CommandResult<()> {
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

pub(crate) fn open_db(app_dir: &Path) -> CommandResult<Db> {
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
    migrate_module_numbering(&conn)?;
    migrate_flashcards(&conn)?;
    asset_refs::migrate(&conn)?;
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
pub(crate) fn migrate_module_numbering(conn: &Connection) -> CommandResult<()> {
    let columns = conn
        .prepare("pragma table_info(modules)")
        .map_err(db_err)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)?;
    if !columns.iter().any(|column| column == "heading_numbering") {
        conn.execute_batch(
            "alter table modules add column heading_numbering INTEGER NOT NULL DEFAULT 0;",
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub(crate) fn migrate_search(conn: &Connection) -> CommandResult<()> {
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
