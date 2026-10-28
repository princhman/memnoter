// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

mod asset_refs;
mod cards;
use cards::migrate_flashcards;

type CommandResult<T> = std::result::Result<T, String>;

struct Db {
    conn: Mutex<Connection>,
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
    migrate_legacy_data(&app_dir)?;
    open_db(&app_dir)
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
            id INTEGER PRIMARY KEY,
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
    asset_refs::migrate(&conn)?;

    Ok(Db {
        conn: Mutex::new(conn),
    })
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
                     insert into contents values ('note', X'0000'), ('other', X'0000');
                     insert into contents_updates values (7, 'note', X'0000', 0);",
                )
                .unwrap();
            }
            Self { dir, db }
        }

        fn file(&self, module: &str) -> String {
            self.file_with_id(module, Uuid::new_v4().to_string())
        }

        fn file_with_id(&self, module: &str, id: String) -> String {
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
        assert_eq!(other_state, vec![0, 0]);
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
            f.cleanup(&[unused.clone(), other.clone()], &[0, 0], 7),
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
        assert!(f.cleanup(&[unused], &[0, 0], 7).is_empty());
    }

    #[test]
    fn card_assets_survive_cleanup_and_source_deletion_preserves_foreign_cards() {
        let f = Fixture::new();
        let id = f.file("note");
        let face = serde_json::json!({"version":1,"fileId":id,"imageId":"image","targetMaskId":"mask","masks":[]}).to_string();
        {
            let conn = f.db.conn.lock().unwrap();
            conn.execute(
                "insert into cards (id,module_id,kind,front,back,due_at,created_at,updated_at)
                values ('image:o:mask','other','occlusion',?1,?1,0,0,0)",
                [&face],
            )
            .unwrap();
        }
        assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
        assert!(f.row_exists(&id));
        f.db.conn
            .lock()
            .unwrap()
            .execute("update cards set deleted_at = 1", [])
            .unwrap();
        assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
        f.db.conn
            .lock()
            .unwrap()
            .execute("update cards set deleted_at = null", [])
            .unwrap();
        delete_module_data(&mut f.db.conn.lock().unwrap(), &f.dir.join("files"), "note").unwrap();
        assert!(f.row_exists(&id));
        assert!(f.dir.join("files").join(id).exists());
        let retired: bool =
            f.db.conn
                .lock()
                .unwrap()
                .query_one(
                    "select deleted_at is not null from cards where id = 'image:o:mask'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert!(!retired);
    }

    #[test]
    fn unopened_plain_copy_survives_owner_cleanup_after_restart() {
        let f = Fixture::new();
        // Real Yjs bytes guard the JS/Rust storage protocol, including nested
        // inline masked images and an ordinary image with no card face.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/shared-images-yjs.json"))
                .unwrap();
        let id = f.file_with_id("note", fixture["fileId"].as_str().unwrap().to_owned());
        let state: Vec<u8> = serde_json::from_value(fixture["state"].clone()).unwrap();
        let updates: Vec<Vec<u8>> = serde_json::from_value(fixture["updates"].clone()).unwrap();
        {
            let conn = f.db.conn.lock().unwrap();
            conn.execute(
                "update contents set state = ?1 where module_id = 'other'",
                [state],
            )
            .unwrap();
            for (i, bytes) in updates.iter().enumerate() {
                conn.execute(
                    "insert into contents_updates values (?1, 'other', ?2, 0)",
                    params![8 + i as i64, bytes],
                )
                .unwrap();
            }
        }
        // Reopen storage: no React document or card face has ever indexed B.
        let restarted = open_db(&f.dir).unwrap();
        assert!(cleanup_unused_files(
            &restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "note",
            std::slice::from_ref(&id),
            &[0, 0],
            7
        )
        .unwrap()
        .is_empty());
        assert!(f.dir.join("files").join(&id).is_file());
        assert!(f.row_exists(&id));
        delete_module_data(
            &mut restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "note",
        )
        .unwrap();
        assert!(f.row_exists(&id));
        assert!(f.dir.join("files").join(&id).is_file());
        delete_module_data(
            &mut restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "other",
        )
        .unwrap();
        assert!(!f.row_exists(&id));
        assert!(!f.dir.join("files").join(&id).exists());
    }

    #[test]
    fn copied_image_lease_survives_removal_compaction_and_restart() {
        use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
        let f = Fixture::new();
        let id = f.file("note");
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("inlineImage"));
        image.insert_attribute(&mut txn, "fileId", id.clone());
        let inserted = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        drop(txn);
        root.remove_range(&mut doc.transact_mut(), 0, 1);
        let removed = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        {
            let mut conn = f.db.conn.lock().unwrap();
            conn.execute(
                "insert into contents_updates values (8, 'other', ?1, 0)",
                [&inserted],
            )
            .unwrap();
            conn.execute(
                "insert into contents_updates values (9, 'other', ?1, 0)",
                [&removed],
            )
            .unwrap();
            compact_content(&mut conn, "other", &removed, 9).unwrap();
            let pending: i64 = conn
                .query_row(
                    "select count(*) from contents_updates where module_id='other'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(pending, 0);
        }
        let restarted = open_db(&f.dir).unwrap();
        assert!(cleanup_unused_files(
            &restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "note",
            std::slice::from_ref(&id),
            &[0, 0],
            7
        )
        .unwrap()
        .is_empty());
        // The persisted destination tree is empty, but its undo lease survives.
        delete_module_data(
            &mut restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "note",
        )
        .unwrap();
        assert_eq!(
            std::fs::read(f.dir.join("files").join(&id)).unwrap(),
            b"image bytes"
        );
        delete_module_data(
            &mut restarted.conn.lock().unwrap(),
            &f.dir.join("files"),
            "other",
        )
        .unwrap();
        assert!(!f.row_exists(&id));
    }

    #[test]
    fn reversed_image_updates_cannot_authorize_cleanup_or_compaction() {
        use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
        let f = Fixture::new();
        let id = f.file("note");
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
        image.insert_attribute(&mut txn, "fileId", id.clone());
        let inserted = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        drop(txn);
        let mut txn = doc.transact_mut();
        root.remove_range(&mut txn, 0, 1);
        let removal = txn.encode_update_v1();
        let final_state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        drop(txn);
        let mut conn = f.db.conn.lock().unwrap();
        conn.execute(
            "insert into contents_updates values (8, 'other', ?1, 0)",
            [&removal],
        )
        .unwrap();
        conn.execute(
            "insert into contents_updates values (9, 'other', ?1, 0)",
            [&inserted],
        )
        .unwrap();
        assert!(cleanup_unused_files(
            &conn,
            &f.dir.join("files"),
            "note",
            std::slice::from_ref(&id),
            &[0, 0],
            7
        )
        .is_err());
        assert!(compact_content(&mut conn, "other", &final_state, 9).is_err());
        assert!(delete_module_data(&mut conn, &f.dir.join("files"), "note").is_err());
        assert!(f.dir.join("files").join(&id).is_file());
    }

    #[test]
    fn invalid_or_incomplete_foreign_notes_cannot_authorize_destruction() {
        use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
        let f = Fixture::new();
        let id = f.file("note");
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
        let before = txn.state_vector();
        image.insert_attribute(&mut txn, "fileId", id.clone());
        let partial = txn.encode_state_as_update_v1(&before);
        for bytes in [vec![255], partial] {
            let mut conn = f.db.conn.lock().unwrap();
            conn.execute(
                "update contents set state = ?1 where module_id='other'",
                [bytes],
            )
            .unwrap();
            assert!(cleanup_unused_files(
                &conn,
                &f.dir.join("files"),
                "note",
                std::slice::from_ref(&id),
                &[0, 0],
                7
            )
            .is_err());
            assert!(delete_module_data(&mut conn, &f.dir.join("files"), "note").is_err());
            assert!(f.dir.join("files").join(&id).is_file());
        }
        assert!(f.row_exists(&id));
    }

    #[test]
    fn stale_snapshots_never_remove_files() {
        let f = Fixture::new();
        let id = f.file("note");
        for (state, update_id) in [(vec![0], 7), (vec![0, 0], 6)] {
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
        assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
        assert!(f.row_exists(&id));
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(
            f.cleanup(std::slice::from_ref(&id), &[0, 0], 7),
            vec![id.clone()]
        );
        assert!(!f.row_exists(&id));
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
    let conn = db.conn.lock().map_err(db_err)?;
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

    Ok(id)
}

#[tauri::command]
fn modules(db: tauri::State<Db>) -> CommandResult<Vec<Module>> {
    let conn = db.conn.lock().map_err(db_err)?;
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
    let conn = db.conn.lock().map_err(db_err)?;

    conn.execute(
        "update modules set name = ?2 where id = ?1",
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
    asset_refs::retain_all(&tx)?;
    // Stored faces (including retired ones) also retain assets. Transfer shared
    // files to a surviving note; deleting the uploader must not break copies.
    tx.execute(
        "insert or ignore into shared_image_refs(module_id, file_id)
         select cards.module_id, files.id from cards join files
         on files.id = json_extract(cards.front, '$.fileId')
         or files.id = json_extract(cards.back, '$.fileId')
         where cards.kind = 'occlusion' and cards.module_id <> ?1",
        [module_id],
    )
    .map_err(db_err)?;
    tx.execute(
        "update files set module_id = (select min(module_id) from shared_image_refs
         where file_id = files.id and module_id <> ?1)
         where module_id = ?1 and exists(select 1 from shared_image_refs
         where file_id = files.id and module_id <> ?1)",
        [module_id],
    )
    .map_err(db_err)?;
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
    let mut conn = db.conn.lock().map_err(db_err)?;
    delete_module_data(&mut conn, &files_dir, &module_id)
}

// Reading and serializing a long edit history must not block the native UI.
#[tauri::command(async)]
fn get_content(db: tauri::State<Db>, module_id: String) -> CommandResult<GetContentResponse> {
    let conn = db.conn.lock().map_err(db_err)?;

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
    let conn = db.conn.lock().map_err(db_err)?;

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
    let mut conn = db.conn.lock().map_err(db_err)?;
    compact_content(&mut conn, &module_id, &new_state, update_id)
}

fn compact_content(
    conn: &mut Connection,
    module_id: &str,
    new_state: &[u8],
    update_id: i64,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    // Keep leases and snapshot replacement atomic. Capture intermediate saved
    // revisions before discarding them, then validate/capture the new snapshot.
    asset_refs::retain_module(&tx, module_id)?;
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
    asset_refs::retain_module(&tx, module_id)?;
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

    let conn = db.conn.lock().map_err(db_err)?;
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
    let _ = module_id; // Copied images may refer to another note's managed asset.
    if Uuid::parse_str(&file_id).is_err() {
        return Err("Invalid file ID".to_string());
    }

    let expected_path = app
        .path()
        .app_data_dir()
        .map_err(db_err)?
        .join("files")
        .join(&file_id);
    let conn = db.conn.lock().map_err(db_err)?;
    let (path, file_type): (String, String) = conn
        .query_row(
            "select path, file_type from files where id = ?1",
            params![file_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;

    if Path::new(&path) != expected_path.as_path() {
        return Err("Stored image path is invalid".to_string());
    }

    let bytes = std::fs::read(expected_path).map_err(db_err)?;
    Ok(FileContents { bytes, file_type })
}

#[tauri::command]
fn resolve_card_image(
    app: tauri::AppHandle,
    db: tauri::State<Db>,
    file_id: String,
) -> CommandResult<String> {
    if Uuid::parse_str(&file_id).is_err() {
        return Err("Invalid image ID".into());
    }
    let conn = db.conn.lock().map_err(db_err)?;
    let path: String = conn
        .query_row("select path from files where id = ?1", [&file_id], |r| {
            r.get(0)
        })
        .map_err(db_err)?;
    let expected = app
        .path()
        .app_data_dir()
        .map_err(db_err)?
        .join("files")
        .join(file_id);
    if Path::new(&path) != expected || !expected.is_file() {
        return Err("Image is unavailable".into());
    }
    Ok(path)
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

    // An invalid/incomplete persisted note cannot authorize asset destruction.
    asset_refs::retain_all(conn)?;
    let mut deleted = Vec::new();
    for id in file_ids {
        // Retain even retired faces: undo restores their ids/history and assets.
        let referenced: bool = conn
            .query_one(
                "select exists(select 1 from shared_image_refs where file_id = ?1)
             or exists(select 1 from cards where kind = 'occlusion'
             and (json_extract(front, '$.fileId') = ?1 or json_extract(back, '$.fileId') = ?1))",
                [id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if referenced {
            continue;
        }
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
    let conn = db.conn.lock().map_err(db_err)?;
    cleanup_unused_files(
        &conn,
        &files_dir,
        &module_id,
        &file_ids,
        &expected_state,
        expected_update_id,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = init_db(app).expect("Failed to init db.");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            resolve_card_image,
            cards::sync_cards,
            cards::unindexed_card_modules,
            cards::due_cards,
            cards::due_counts,
            cards::review_card
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
