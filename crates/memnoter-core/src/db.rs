use crate::*;
pub struct Db {
    pub(crate) data_dir: PathBuf,
    pub(crate) conn: Mutex<Connection>,
    pub(crate) unavailable: AtomicBool,
    pub(crate) outbox_callback: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
}

impl Db {
    pub fn lock(&self) -> CommandResult<DbGuard<'_>> {
        let conn = self.conn.lock().map_err(db_err)?;
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Database unavailable. Restart the app to recover.".into());
        }
        let before = outbox_revision(&conn);
        Ok(DbGuard {
            conn: Some(conn),
            db: self,
            before,
        })
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
    let conn = Connection::open(db_path).map_err(db_err)?;
    rebase_file_paths(&conn, files_dir)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(db_err)?;
    conn.close().map_err(|(_, error)| db_err(error))
}

// Refresh the legacy path column for older builds opening relocated storage.
// Current readers derive paths from IDs; they never trust these receipts.
// Idempotent: unchanged receipts do not cause writes, and old backups work too.
fn rebase_file_paths(conn: &Connection, files_dir: &Path) -> CommandResult<()> {
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    let ids = tx
        .prepare("select id from files")
        .map_err(db_err)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)?;
    for id in ids {
        // Never let database-controlled identifiers escape managed storage.
        // Leave corrupt rows untouched so read/delete guards still reject them.
        if Uuid::parse_str(&id).is_err() {
            continue;
        }
        let path =
            crate::files::assets::path(files_dir.parent().ok_or("Invalid files directory")?, &id)?;
        let path_str = path
            .to_str()
            .ok_or_else(|| "File path is not valid UTF-8".to_string())?;
        tx.execute(
            "update files set path = ?1 where id = ?2 and path <> ?1",
            params![path_str, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(())
}

// AUTOINCREMENT preserves the high-water mark even after compaction empties
// the table. A stale read must never authorize deleting a newly reused id.
pub(crate) fn migrate_update_ids(conn: &Connection) -> CommandResult<()> {
    // Version-zero databases include both ROWID and AUTOINCREMENT schemas.
    // Preserve a previously compacted AUTOINCREMENT high-water mark as well.
    let sequence_exists: bool = conn
        .query_row(
            "select exists(select 1 from sqlite_master where name = 'sqlite_sequence')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let sequence: i64 = if sequence_exists {
        conn.query_row(
            "select seq from sqlite_sequence where name = 'contents_updates'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?
        .unwrap_or(0)
    } else {
        0
    };
    conn.execute_batch(
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
    conn.execute(
        "update sqlite_sequence set seq = max(seq, ?1) where name = 'contents_updates'",
        [sequence],
    )
    .map_err(db_err)?;
    Ok(())
}

pub(crate) fn open_db(app_dir: &Path) -> CommandResult<Db> {
    std::fs::create_dir_all(app_dir).map_err(db_err)?;

    let db_path = app_dir.join("main.db");
    let conn = Connection::open(&db_path).map_err(db_err)?;

    let files_path = app_dir.join("files");
    std::fs::create_dir_all(&files_path).map_err(db_err)?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    )
    .map_err(db_err)?;
    migrate(&conn)?;

    rebase_file_paths(&conn, &files_path)?;
    crate::files::assets::cleanup_orphans(&conn, &files_path)?;

    Ok(Db {
        data_dir: app_dir.to_path_buf(),
        conn: Mutex::new(conn),
        unavailable: AtomicBool::new(false),
        outbox_callback: Mutex::new(None),
    })
}

// Full-text search over every module: one row per module, with its title, the
// plain text of the note and the LaTeX source of its formulas. unicode61 with
// remove_diacritics folds case and accents; the prefix index keeps type-ahead
// queries ("integ*") fast. search_index_state records which extractor version
// produced each row, so the frontend can re-index after the extractor changes.
pub(crate) fn migrate_module_numbering(conn: &Connection) -> CommandResult<()> {
    ensure_column(
        conn,
        "modules",
        "heading_numbering",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

// Only the version-zero compatibility migration probes columns. Older hosts
// may have installed any prefix of the historical unversioned upgrades.
pub(crate) fn ensure_column(
    conn: &Connection,
    table: &str,
    name: &str,
    declaration: &str,
) -> CommandResult<bool> {
    let exists = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(db_err)?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)?
        .iter()
        .any(|column| column == name);
    if !exists {
        conn.execute_batch(&format!(
            "alter table {table} add column {name} {declaration}"
        ))
        .map_err(db_err)?;
    }
    Ok(!exists)
}

fn migrate_base(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "
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
    .map_err(db_err)
}

const MIGRATIONS: &[fn(&Connection) -> CommandResult<()>] =
    &[migrate_base, migrate_unversioned, migrate_update_ids];

fn migrate_unversioned(conn: &Connection) -> CommandResult<()> {
    migrate_module_numbering(conn)?;
    migrate_flashcards(conn)?;
    asset_refs::migrate(conn)?;
    migrate_search(conn)?;
    crate::sync::migrate(conn)?;
    // Force one backfill when adopting versioned migrations, including the
    // historical two-way syntax upgrade; syntax_version is no longer read.
    conn.execute("delete from card_indexed_modules", [])
        .map_err(db_err)?;
    Ok(())
}

pub(crate) fn migrate(conn: &Connection) -> CommandResult<()> {
    let version: i64 = conn
        .query_row("pragma user_version", [], |r| r.get(0))
        .map_err(db_err)?;
    if version > MIGRATIONS.len() as i64 {
        return Err("Database schema is newer than this build".into());
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        migration(&tx)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
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

// sqlite_sequence is transactional: rollback cannot generate a notification.
// The generation also detects a restore that reuses the old outbox ids.
fn outbox_revision(conn: &Connection) -> Option<(i64, String)> {
    conn.query_row("select coalesce((select seq from sqlite_sequence where name = 'sync_outbox'), 0), coalesce((select value from sync_state where key = 'generation'), '')", [], |row| Ok((row.get(0)?, row.get(1)?))).ok()
}
pub struct DbGuard<'a> {
    conn: Option<std::sync::MutexGuard<'a, Connection>>,
    db: &'a Db,
    before: Option<(i64, String)>,
}
impl std::ops::Deref for DbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().unwrap()
    }
}
impl Drop for DbGuard<'_> {
    fn drop(&mut self) {
        let conn = self.conn.as_ref().unwrap();
        let changed = conn.is_autocommit()
            && outbox_revision(conn) != self.before
            && conn
                .query_row("select exists(select 1 from sync_outbox)", [], |r| {
                    r.get::<_, bool>(0)
                })
                .unwrap_or(false);
        let callback = if changed {
            self.db
                .outbox_callback
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        } else {
            None
        };
        // Hosts can immediately query the core from their callback.
        drop(self.conn.take());
        if let Some(callback) = callback {
            callback();
        }
    }
}

impl std::fmt::Debug for DbGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbGuard").finish_non_exhaustive()
    }
}
