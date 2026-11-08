// Snapshots of the database and images under app_data_dir/backups/<id>/, and
// restoring from them.

use super::{db_err, open_db, CommandResult, Db};
use chrono::{DateTime, NaiveDateTime, TimeDelta, Utc};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const KEEP_BACKUPS: usize = 7;
const BACKUP_INTERVAL: TimeDelta = TimeDelta::hours(24);
// Sorts chronologically and is safe as a directory name.
const ID_FORMAT: &str = "%Y-%m-%dT%H-%M-%S%.3fZ";

// A restore moves the live data here until the restored database is in place.
const RESTORE_OLD: &str = "restore-old";
const RESTORE_CLEANUP: &str = "restore-cleanup";
const RESTORE_STAGING: &str = "restore-staging";
// Moved before main.db, so main.db is the last file to leave or arrive.
const DB_FILES: [&str; 3] = ["main.db-wal", "main.db-shm", "main.db"];

#[derive(Debug, serde::Serialize)]
pub struct Backup {
    id: String,
    created_at: i64,
}

fn backups_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("backups")
}

fn parse_id(id: &str) -> Option<DateTime<Utc>> {
    let time = NaiveDateTime::parse_from_str(id, ID_FORMAT).ok()?.and_utc();
    // Only accept ids this module wrote, never a path such as "../x".
    (time.format(ID_FORMAT).to_string() == id).then_some(time)
}

fn remove_if_exists(path: &Path) -> CommandResult<()> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(db_err(error)),
        _ => Ok(()),
    }
}

fn rename_if_exists(from: &Path, to: &Path) -> CommandResult<()> {
    if from.exists() {
        std::fs::rename(from, to).map_err(db_err)?;
    }
    Ok(())
}

// Saved images are never modified in place, so snapshots can share them with
// hard links instead of duplicating every image seven times.
fn link_or_copy_dir(from: &Path, to: &Path) -> CommandResult<()> {
    std::fs::create_dir_all(to).map_err(db_err)?;
    if !from.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(from).map_err(db_err)? {
        let entry = entry.map_err(db_err)?;
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(db_err)?.is_dir() {
            link_or_copy_dir(&entry.path(), &target)?;
        } else if std::fs::hard_link(entry.path(), &target).is_err() {
            std::fs::copy(entry.path(), &target).map_err(db_err)?;
        }
    }
    Ok(())
}

pub fn list(app_dir: &Path) -> CommandResult<Vec<Backup>> {
    let dir = backups_dir(app_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(db_err)? {
        let entry = entry.map_err(db_err)?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(time) = parse_id(&id) else { continue };
        if entry.path().join("main.db").is_file() {
            backups.push(Backup {
                id,
                created_at: time.timestamp_millis(),
            });
        }
    }
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(backups)
}

// The caller holds the database lock, so no save can land between copying the
// database and copying the images it references.
pub fn create(conn: &Connection, app_dir: &Path, now: DateTime<Utc>) -> CommandResult<Backup> {
    let dir = backups_dir(app_dir);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let mut time = now;
    if let Some(latest) = list(app_dir)?
        .first()
        .and_then(|backup| parse_id(&backup.id))
    {
        time = time.max(latest + TimeDelta::milliseconds(1));
    }
    while dir.join(time.format(ID_FORMAT).to_string()).exists() {
        time += TimeDelta::milliseconds(1);
    }
    let id = time.format(ID_FORMAT).to_string();

    // Built under a name list() ignores, and renamed into place once complete.
    let partial = dir.join(format!(".partial-{}", Uuid::new_v4()));
    let result = (|| {
        std::fs::create_dir(&partial).map_err(db_err)?;
        let db_path = partial.join("main.db");
        let db_path = db_path
            .to_str()
            .ok_or_else(|| "Backup path is not valid UTF-8".to_string())?;
        conn.execute("VACUUM INTO ?1", [db_path]).map_err(db_err)?;
        link_or_copy_dir(&app_dir.join("files"), &partial.join("files"))?;
        std::fs::rename(&partial, dir.join(&id)).map_err(db_err)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&partial);
    }
    result?;

    Ok(Backup {
        created_at: parse_id(&id).unwrap_or(time).timestamp_millis(),
        id,
    })
}

pub fn prune(app_dir: &Path, keep: usize) -> CommandResult<()> {
    for backup in list(app_dir)?.into_iter().skip(keep) {
        let path = backups_dir(app_dir).join(backup.id);
        let trash = backups_dir(app_dir).join(format!(".partial-prune-{}", Uuid::new_v4()));
        std::fs::rename(path, &trash).map_err(db_err)?;
        remove_if_exists(&trash)?;
    }
    // Left behind by a backup that was interrupted.
    for entry in std::fs::read_dir(backups_dir(app_dir)).map_err(db_err)? {
        let entry = entry.map_err(db_err)?;
        if entry.file_name().to_string_lossy().starts_with(".partial-") {
            remove_if_exists(&entry.path())?;
        }
    }
    Ok(())
}

pub fn backup_if_due(
    conn: &Connection,
    app_dir: &Path,
    now: DateTime<Utc>,
) -> CommandResult<Option<Backup>> {
    if let Some(latest) = list(app_dir)?.first() {
        let latest = DateTime::from_timestamp_millis(latest.created_at).unwrap_or_default();
        // A clock that moved backwards should not stop backups for a long time.
        if latest <= now && now - latest < BACKUP_INTERVAL {
            return Ok(None);
        }
    }
    let backup = create(conn, app_dir, now)?;
    maintenance(prune(app_dir, KEEP_BACKUPS));
    Ok(Some(backup))
}

// Finishes or undoes a restore. The restored main.db arriving is the commit
// point: before it, the moved-aside data is put back; after it, discarded.
// Runs on launch too, in case the app quit midway through a restore.
pub fn settle_restore(app_dir: &Path) -> CommandResult<()> {
    let old = app_dir.join(RESTORE_OLD);
    // This directory can only contain committed/fully rolled-back garbage.
    maintenance(remove_if_exists(&app_dir.join(RESTORE_CLEANUP)));
    if old.exists() {
        if !old.join("main.db").exists()
            && old.join("files").exists()
            && app_dir.join("main.db").exists()
            && !app_dir.join(RESTORE_STAGING).exists()
        {
            return Err("Ambiguous legacy restore residue. Preserve the data directory and recover it before restarting.".into());
        }
        let committed = old.join("main.db").exists() && app_dir.join("main.db").exists();
        if !committed {
            if old.join("files").exists() {
                remove_if_exists(&app_dir.join("files"))?;
                std::fs::rename(old.join("files"), app_dir.join("files")).map_err(db_err)?;
            }
            for name in DB_FILES {
                if old.join(name).exists() {
                    remove_if_exists(&app_dir.join(name))?;
                    std::fs::rename(old.join(name), app_dir.join(name)).map_err(db_err)?;
                }
            }
        }
        // Remove the recovery identity atomically before recursive deletion.
        std::fs::rename(&old, app_dir.join(RESTORE_CLEANUP)).map_err(db_err)?;
    }
    maintenance(remove_if_exists(&app_dir.join(RESTORE_CLEANUP)));
    maintenance(remove_if_exists(&app_dir.join(RESTORE_STAGING)));
    Ok(())
}

fn maintenance(result: CommandResult<()>) {
    if let Err(error) = result {
        eprintln!("Backup maintenance failed: {error}");
    }
}

fn stage_restore(source: &Path, app_dir: &Path, account: Option<&str>) -> CommandResult<PathBuf> {
    let staging = app_dir.join(RESTORE_STAGING);
    remove_if_exists(&staging)?;
    std::fs::create_dir_all(&staging).map_err(db_err)?;
    let db_path = staging.join("main.db");
    std::fs::copy(source.join("main.db"), &db_path).map_err(db_err)?;
    link_or_copy_dir(&source.join("files"), &staging.join("files"))?;

    let check: String = Connection::open(&db_path)
        .and_then(|conn| conn.query_one("PRAGMA quick_check", [], |row| row.get(0)))
        .map_err(db_err)?;
    if check != "ok" {
        return Err(format!("Backup is damaged: {check}"));
    }
    // Reconcile before the swap so failure leaves the live database untouched.
    let staged = open_db(&staging)?;
    let mut conn = staged.lock()?;
    super::sync::reconcile_restored_account(&mut conn, account)?;
    Ok(staging)
}

fn swap_in(staging: &Path, app_dir: &Path) -> CommandResult<()> {
    let old = app_dir.join(RESTORE_OLD);
    remove_if_exists(&old)?;
    std::fs::create_dir(&old).map_err(db_err)?;
    rename_if_exists(&app_dir.join("files"), &old.join("files"))?;
    std::fs::rename(staging.join("files"), app_dir.join("files")).map_err(db_err)?;
    for name in DB_FILES {
        rename_if_exists(&app_dir.join(name), &old.join(name))?;
    }
    std::fs::rename(staging.join("main.db"), app_dir.join("main.db")).map_err(db_err)
}

pub fn restore(
    conn: &mut Connection,
    app_dir: &Path,
    id: &str,
    now: DateTime<Utc>,
) -> CommandResult<()> {
    settle_restore(app_dir)?;
    let source = backups_dir(app_dir).join(id);
    if parse_id(id).is_none() || !source.join("main.db").is_file() {
        return Err("Backup not found".into());
    }
    // Keep the current data restorable in case this restore was a mistake.
    create(conn, app_dir, now)?;
    let account = super::sync::status(conn)?.account;
    let staging = match stage_restore(&source, app_dir, account.as_deref()) {
        Ok(staging) => staging,
        Err(error) => {
            let _ = remove_if_exists(&app_dir.join(RESTORE_STAGING));
            return Err(error);
        }
    };

    // SQLite keeps main.db and its WAL and SHM files open; close it so they
    // can be moved. Closing checkpoints the WAL into main.db.
    let placeholder = Connection::open_in_memory().map_err(db_err)?;
    if let Err((open, error)) = std::mem::replace(conn, placeholder).close() {
        *conn = open;
        let _ = remove_if_exists(&staging);
        return Err(db_err(error));
    }

    let swapped = swap_in(&staging, app_dir);
    let settled = settle_restore(app_dir);
    if swapped.is_err() && settled.is_err() {
        return Err(
            "Database unavailable. Restart required: restore rollback could not complete".into(),
        );
    }
    // Reopen whichever database is now in place, restored or rolled back.
    if !app_dir.join("main.db").is_file() {
        return Err(
            "Database unavailable. Restart required: recovery did not leave a database".into(),
        );
    }
    *conn = open_db(app_dir)
        .map_err(|error| format!("Database unavailable. Restart required: {error}"))?
        .conn
        .into_inner()
        .map_err(db_err)?;
    swapped?;
    maintenance(settled);
    maintenance(prune(app_dir, KEEP_BACKUPS));
    Ok(())
}

pub fn list_backups(data_dir: &Path) -> CommandResult<Vec<Backup>> {
    list(data_dir)
}

pub fn backup_now(data_dir: &Path, db: &Db) -> CommandResult<Backup> {
    let dir = data_dir;
    let conn = db.lock()?;
    let backup = create(&conn, dir, Utc::now())?;
    maintenance(prune(dir, KEEP_BACKUPS));
    Ok(backup)
}

pub fn restore_backup(
    data_dir: &Path,
    db: &Db,
    id: String,
) -> std::result::Result<(), crate::CoreError> {
    let dir = data_dir;
    let mut conn = db.lock()?;
    let result = restore(&mut conn, dir, &id, Utc::now()).map_err(crate::CoreError::from);
    if result
        .as_ref()
        .is_err_and(|error| matches!(error, crate::CoreError::Unavailable))
    {
        db.unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    result
}

/// Run the launch-time daily backup check off the caller's thread.
/// The 24-hour backup interval is persisted in snapshots.
pub fn spawn_daily_backup(core: std::sync::Arc<crate::Core>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let result = core
            .db
            .lock()
            .and_then(|conn| backup_if_due(&conn, core.data_dir(), Utc::now()));
        if let Err(error) = result {
            eprintln!("Daily backup failed: {error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_image(dir: &Path, module: &str, bytes: &[u8]) -> String {
        let core = crate::Core::open(dir).unwrap();
        let raw = crate::dispatch(
            &core,
            "save_file",
            &serde_json::json!({
                "moduleId":module, "bytes":bytes, "mimeType":"image/png",
            })
            .to_string(),
        )
        .unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    use chrono::TimeZone;
    use rusqlite::params;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("notes-backups-{}", Uuid::new_v4())))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn at(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap() + TimeDelta::hours(hour.into())
    }

    fn ids(dir: &Path) -> Vec<String> {
        list(dir)
            .unwrap()
            .into_iter()
            .map(|backup| backup.id)
            .collect()
    }

    fn state(conn: &Connection) -> Vec<u8> {
        conn.query_one(
            "select state from contents where module_id = 'note'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn clock_rollback_keeps_fresh_and_pre_restore_snapshots() {
        let dir = TempDir::new();
        let mut conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
        conn.execute_batch("insert into modules (id, name) values ('note', 'Note'); insert into contents values ('note', X'01');").unwrap();
        let original = create(&conn, &dir.0, at(20)).unwrap();
        for hour in 21..28 {
            create(&conn, &dir.0, at(hour)).unwrap();
        }
        conn.execute("update contents set state = X'02'", [])
            .unwrap();
        restore(&mut conn, &dir.0, &original.id, at(0)).unwrap();
        let undo = ids(&dir.0)[0].clone();
        assert_eq!(ids(&dir.0).len(), KEEP_BACKUPS);
        restore(&mut conn, &dir.0, &undo, at(0)).unwrap();
        assert_eq!(state(&conn), vec![2]);
    }

    #[test]
    fn committed_cleanup_leftovers_never_replace_live_images() {
        let dir = TempDir::new();
        let garbage = dir.0.join(RESTORE_CLEANUP);
        std::fs::create_dir_all(garbage.join("files")).unwrap();
        // Recursive cleanup already removed the old main.db, then the app quit.
        std::fs::write(garbage.join("files/old"), b"old").unwrap();
        std::fs::create_dir_all(dir.0.join("files")).unwrap();
        std::fs::write(dir.0.join("files/new"), b"new").unwrap();
        std::fs::write(dir.0.join("main.db"), b"restored").unwrap();
        settle_restore(&dir.0).unwrap();
        settle_restore(&dir.0).unwrap();
        assert_eq!(std::fs::read(dir.0.join("main.db")).unwrap(), b"restored");
        assert_eq!(std::fs::read(dir.0.join("files/new")).unwrap(), b"new");
        assert!(!dir.0.join("files/old").exists());
    }

    #[test]
    fn startup_recovers_before_considering_legacy_import() {
        let root = TempDir::new();
        let live = root.0.join("current");
        let mut conn = open_db(&live).unwrap().conn.into_inner().unwrap();
        conn.execute_batch("insert into modules (id, name) values ('note', 'Note'); insert into contents values ('note', X'02');").unwrap();
        conn.close().unwrap();
        let legacy = root.0.join(super::super::LEGACY_IDENTIFIER);
        conn = open_db(&legacy).unwrap().conn.into_inner().unwrap();
        conn.execute_batch("insert into modules (id, name) values ('note', 'Note'); insert into contents values ('note', X'01');").unwrap();
        conn.close().unwrap();
        std::fs::create_dir(live.join(RESTORE_OLD)).unwrap();
        std::fs::rename(live.join("main.db"), live.join(RESTORE_OLD).join("main.db")).unwrap();
        let recovered = super::super::initialize_data(&live).unwrap();
        assert_eq!(state(&recovered.conn.lock().unwrap()), vec![2]);
        recovered
            .unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(recovered.lock().unwrap_err().contains("Restart"));
    }

    #[test]
    fn keeps_only_the_newest_snapshots() {
        let dir = TempDir::new();
        let conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
        for hour in 0..9 {
            create(&conn, &dir.0, at(hour)).unwrap();
        }
        std::fs::create_dir(backups_dir(&dir.0).join(".partial-left-over")).unwrap();
        prune(&dir.0, KEEP_BACKUPS).unwrap();
        let expected: Vec<String> = (2..9)
            .rev()
            .map(|hour| at(hour).format(ID_FORMAT).to_string())
            .collect();
        assert_eq!(ids(&dir.0), expected);
        assert_eq!(std::fs::read_dir(backups_dir(&dir.0)).unwrap().count(), 7);
    }

    #[test]
    fn backs_up_at_most_once_a_day() {
        let dir = TempDir::new();
        let conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
        assert!(backup_if_due(&conn, &dir.0, at(0)).unwrap().is_some());
        assert!(backup_if_due(&conn, &dir.0, at(23)).unwrap().is_none());
        assert!(backup_if_due(&conn, &dir.0, at(24)).unwrap().is_some());
        // Same millisecond: still two distinct snapshots.
        create(&conn, &dir.0, at(24)).unwrap();
        assert_eq!(ids(&dir.0).len(), 3);
    }

    #[test]
    fn restore_brings_back_the_database_and_images() {
        let dir = TempDir::new();
        let db = open_db(&dir.0).unwrap();
        let conn = db.lock().unwrap();
        conn.execute_batch(
            "insert into modules (id, name) values ('note', 'Note');
             insert into contents values ('note', X'01');",
        )
        .unwrap();
        let image = save_image(&dir.0, "note", b"image bytes");
        let image_path = dir.0.join("files").join(&image);
        drop(conn);
        super::super::index_note(
            &db,
            "note".into(),
            "original searchable".into(),
            "".into(),
            1,
            false,
        )
        .unwrap();
        let conn = db.lock().unwrap();
        let backup = create(&conn, &dir.0, at(0)).unwrap();
        drop(conn);
        super::super::index_note(
            &db,
            "note".into(),
            "replacement searchable".into(),
            "".into(),
            1,
            false,
        )
        .unwrap();
        let mut conn = db.lock().unwrap();

        conn.execute_batch(
            "update contents set state = X'02';
             insert into modules (id, name) values ('later', 'Later');
             delete from files;",
        )
        .unwrap();
        std::fs::remove_file(&image_path).unwrap();
        std::fs::write(dir.0.join("files").join("later"), b"later").unwrap();

        restore(&mut conn, &dir.0, &backup.id, at(1)).unwrap();

        assert_eq!(state(&conn), vec![1]);
        drop(conn);
        assert_eq!(
            super::super::search_notes(&db, "original".into(), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(super::super::search_notes(&db, "replacement".into(), 10)
            .unwrap()
            .is_empty());
        let mut conn = db.lock().unwrap();
        let modules: i64 = conn
            .query_one("select count(*) from modules", [], |row| row.get(0))
            .unwrap();
        assert_eq!(modules, 1);
        assert_eq!(std::fs::read(&image_path).unwrap(), b"image bytes");
        assert!(!dir.0.join("files").join("later").exists());
        assert!(!dir.0.join(RESTORE_OLD).exists());
        assert!(!dir.0.join(RESTORE_STAGING).exists());
        // The state before the restore was kept as its own snapshot.
        let ids = ids(&dir.0);
        assert_eq!(ids, vec![at(1).format(ID_FORMAT).to_string(), backup.id]);

        // The restored connection is fully usable, and so is the undo snapshot.
        conn.execute("update contents set state = X'03'", [])
            .unwrap();
        restore(&mut conn, &dir.0, &ids[0], at(2)).unwrap();
        assert_eq!(state(&conn), vec![2]);
        drop(conn);
        assert_eq!(
            super::super::search_notes(&db, "replacement".into(), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(super::super::search_notes(&db, "original".into(), 10)
            .unwrap()
            .is_empty());
        assert!(dir.0.join("files").join("later").exists());
    }

    // This crosses the snapshot/reopen boundary: a compacted-away foreign
    // reference must survive independently of both the visible tree and cards.
    #[test]
    fn restore_retains_compacted_image_leases_and_occlusion_cards() {
        use crate::{delete_module_data, save_compaction};
        use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
        let dir = TempDir::new();
        let db = open_db(&dir.0).unwrap();
        let conn = db.lock().unwrap();
        conn.execute_batch(
            "insert into modules (id, name) values ('source', 'Source'), ('copy', 'Copy');
             insert into contents values ('source', X'0000'), ('copy', X'0000');",
        )
        .unwrap();
        let image = save_image(&dir.0, "source", b"shared pixels");
        let path = dir.0.join("files").join(&image);
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let node = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
        node.insert_attribute(&mut txn, "fileId", image.clone());
        let inserted = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        drop(txn);
        root.remove_range(&mut doc.transact_mut(), 0, 1);
        let removed = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        conn.execute(
            "insert into contents_updates (module_id,bytes,created_at) values ('copy',?1,0)",
            [&inserted],
        )
        .unwrap();
        conn.execute(
            "insert into contents_updates (module_id,bytes,created_at) values ('copy',?1,0)",
            [&removed],
        )
        .unwrap();
        let watermark = conn.last_insert_rowid();
        drop(conn);
        save_compaction(&db, "copy".into(), removed.clone(), watermark).unwrap();
        let mut conn = db.lock().unwrap();
        let front = serde_json::json!({"version":1,"fileId":image,"imageId":"image","targetMaskId":"mask","revealed":false,"masks":[{"id":"mask","shape":"rectangle","x":0.1,"y":0.1,"width":0.2,"height":0.2}]}).to_string();
        let mut back: serde_json::Value = serde_json::from_str(&front).unwrap();
        back["revealed"] = true.into();
        conn.execute("insert into cards (id,module_id,kind,front,back,due_at,created_at,updated_at,reps) values ('image:o:mask','copy','occlusion',?1,?2,123,0,0,4)", params![front,back.to_string()]).unwrap();
        let backup = create(&conn, &dir.0, at(0)).unwrap();
        conn.execute_batch("delete from cards; delete from shared_image_refs;")
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        restore(&mut conn, &dir.0, &backup.id, at(1)).unwrap();
        let restored: (String, String, i64, i64) = conn
            .query_row(
                "select front,back,due_at,reps from cards where id='image:o:mask'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(restored, (front, back.to_string(), 123, 4));
        // Remove cards so they cannot accidentally mask a lost lease.
        conn.execute("delete from cards", []).unwrap();
        delete_module_data(&mut conn, &dir.0.join("files"), "source").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"shared pixels");
        let owner: String = conn
            .query_row("select module_id from files where id=?1", [&image], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(owner, "copy");
        delete_module_data(&mut conn, &dir.0.join("files"), "copy").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn restore_keeps_device_account_and_reconciles_snapshot_sync_state() {
        // Include renewed desktop credentials: identity, not token, owns the cursor.
        let desktop_old = r#"{"server":"https://sync","userId":"a","token":"old"}"#;
        let desktop_new = r#"{"server":"https://sync","userId":"a","token":"new"}"#;
        for (restored, current, keep) in [
            (Some("a"), Some("a"), true),
            (None, Some("a"), false),
            (Some("b"), Some("a"), false),
            (Some("b"), None, false),
            (Some(desktop_old), Some(desktop_new), true),
            (
                Some(desktop_old),
                Some(r#"{"server":"https://other","userId":"a"}"#),
                false,
            ),
        ] {
            let dir = TempDir::new();
            let mut conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
            conn.execute("insert into modules (id,name) values ('note','Note')", [])
                .unwrap();
            let image = save_image(&dir.0, "note", b"pixels");
            if let Some(account) = restored {
                conn.execute("insert into sync_state values ('account',?1)", [account])
                    .unwrap();
                conn.execute("insert into sync_state values ('cursor',42)", [])
                    .unwrap();
                conn.execute(
                    "insert into sync_outbox (doc,bytes) values ('old-account',X'01')",
                    [],
                )
                .unwrap();
                conn.execute(
                    "insert into sync_docs (doc,state) values ('old-account',X'0000')",
                    [],
                )
                .unwrap();
            }
            let backup = create(&conn, &dir.0, at(0)).unwrap();
            conn.execute_batch(
                "delete from sync_state; delete from sync_outbox; delete from sync_docs;",
            )
            .unwrap();
            if let Some(account) = current {
                conn.execute("insert into sync_state values ('account',?1)", [account])
                    .unwrap();
            }
            restore(&mut conn, &dir.0, &backup.id, at(1)).unwrap();
            let status = serde_json::to_value(super::super::sync::status(&conn).unwrap()).unwrap();
            let expected = current.map(|raw| {
                let value: serde_json::Value =
                    serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
                if value["server"].is_string() && value["userId"].is_string() {
                    serde_json::json!({"server":value["server"],"userId":value["userId"]})
                        .to_string()
                } else {
                    raw.to_string()
                }
            });
            // Restoring a legacy backup preserves the identity cursor without
            // putting renewed credentials back into subsequent backups.
            assert_eq!(status["account"], serde_json::json!(expected));
            assert_eq!(status["cursor"], if keep { 42 } else { 0 });
            let docs: Vec<String> = conn
                .prepare("select doc from sync_outbox")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            if keep {
                assert_eq!(docs, ["old-account"]);
            } else if current.is_some() {
                assert_eq!(docs, ["vault"]);
            } else {
                assert!(docs.is_empty());
            }
            let stale: i64 = conn
                .query_row(
                    "select count(*) from sync_docs where doc='old-account'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stale, i64::from(keep));
            let uploads: Vec<String> = conn
                .prepare("select file_id from sync_file_uploads")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            if current.is_some() && !keep {
                assert_eq!(uploads, [image]);
            } else {
                assert!(uploads.is_empty());
            }

            assert_eq!(
                super::super::sync::record_update(&conn, "note", &[0, 0]).unwrap(),
                current.is_some()
            );
        }
    }

    #[test]
    fn restore_rejects_unknown_ids() {
        let dir = TempDir::new();
        let mut conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
        for id in ["../main.db", "missing", "2026-10-01T00-00-00.000Z"] {
            assert!(restore(&mut conn, &dir.0, id, at(0)).is_err());
        }
        assert!(ids(&dir.0).is_empty());
    }

    #[test]
    fn interrupted_restore_is_rolled_back_on_launch() {
        let dir = TempDir::new();
        let old = dir.0.join(RESTORE_OLD);
        std::fs::create_dir_all(old.join("files")).unwrap();
        std::fs::write(old.join("main.db"), b"current db").unwrap();
        std::fs::write(old.join("files").join("a"), b"current image").unwrap();
        // Quit after the images were swapped but before main.db arrived.
        std::fs::create_dir_all(dir.0.join("files")).unwrap();
        std::fs::write(dir.0.join("files").join("b"), b"restored image").unwrap();
        std::fs::create_dir_all(dir.0.join(RESTORE_STAGING)).unwrap();
        std::fs::write(dir.0.join(RESTORE_STAGING).join("main.db"), b"restored db").unwrap();

        settle_restore(&dir.0).unwrap();

        assert_eq!(std::fs::read(dir.0.join("main.db")).unwrap(), b"current db");
        assert!(dir.0.join("files").join("a").exists());
        assert!(!dir.0.join("files").join("b").exists());
        assert!(!old.exists());
        assert!(!dir.0.join(RESTORE_STAGING).exists());
    }
}
