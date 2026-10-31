// Snapshots of the database and images under app_data_dir/backups/<id>/, and
// restoring from them.

use super::{db_err, open_db, rewrite_file_paths, CommandResult, Db};
use chrono::{DateTime, NaiveDateTime, TimeDelta, Utc};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tauri::Manager;
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
pub(crate) struct Backup {
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

pub(crate) fn list(app_dir: &Path) -> CommandResult<Vec<Backup>> {
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
    // Newest first.
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(backups)
}

// The caller holds the database lock, so no save can land between copying the
// database and copying the images it references.
pub(crate) fn create(
    conn: &Connection,
    app_dir: &Path,
    now: DateTime<Utc>,
) -> CommandResult<Backup> {
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

pub(crate) fn prune(app_dir: &Path, keep: usize) -> CommandResult<()> {
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

pub(crate) fn backup_if_due(
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
pub(crate) fn settle_restore(app_dir: &Path) -> CommandResult<()> {
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

fn stage_restore(source: &Path, app_dir: &Path) -> CommandResult<PathBuf> {
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
    // Stored image paths are absolute; point them at this data dir.
    rewrite_file_paths(&db_path, &app_dir.join("files"))?;
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

pub(crate) fn restore(
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
    let staging = match stage_restore(&source, app_dir) {
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

fn app_dir(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    app.path().app_data_dir().map_err(db_err)
}

// Holds the database lock while it runs, like backup_now, so it is consistent.
pub(crate) fn spawn_daily_backup(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = app_dir(&app).and_then(|dir| {
            let db = app.state::<Db>();
            let conn = db.lock()?;
            backup_if_due(&conn, &dir, Utc::now())
        });
        if let Err(error) = result {
            eprintln!("Daily backup failed: {error}");
        }
    });
}

#[tauri::command(async)]
pub(crate) fn list_backups(app: tauri::AppHandle) -> CommandResult<Vec<Backup>> {
    list(&app_dir(&app)?)
}

#[tauri::command(async)]
pub(crate) fn backup_now(app: tauri::AppHandle, db: tauri::State<'_, Db>) -> CommandResult<Backup> {
    let dir = app_dir(&app)?;
    let conn = db.lock()?;
    let backup = create(&conn, &dir, Utc::now())?;
    maintenance(prune(&dir, KEEP_BACKUPS));
    Ok(backup)
}

#[tauri::command(async)]
pub(crate) fn restore_backup(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    id: String,
) -> CommandResult<()> {
    let dir = app_dir(&app)?;
    let mut conn = db.lock()?;
    let result = restore(&mut conn, &dir, &id, Utc::now());
    if result
        .as_ref()
        .is_err_and(|error| error.starts_with("Database unavailable."))
    {
        db.unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
        conn.execute_batch("insert into modules values ('note', 'Note'); insert into contents values ('note', X'01');").unwrap();
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
        conn.execute_batch("insert into modules values ('note', 'Note'); insert into contents values ('note', X'02');").unwrap();
        conn.close().unwrap();
        let legacy = root.0.join(super::super::LEGACY_IDENTIFIER);
        conn = open_db(&legacy).unwrap().conn.into_inner().unwrap();
        conn.execute_batch("insert into modules values ('note', 'Note'); insert into contents values ('note', X'01');").unwrap();
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
        let mut conn = open_db(&dir.0).unwrap().conn.into_inner().unwrap();
        let image = Uuid::new_v4().to_string();
        let image_path = dir.0.join("files").join(&image);
        std::fs::write(&image_path, b"image bytes").unwrap();
        conn.execute_batch(
            "insert into modules values ('note', 'Note');
             insert into contents values ('note', X'01');",
        )
        .unwrap();
        conn.execute(
            "insert into files values (?1, 'note', ?2, 'image/png')",
            params![image, image_path.to_str().unwrap()],
        )
        .unwrap();
        super::super::index_note_text(&mut conn, "note", "original searchable", "", 1, false)
            .unwrap();
        let backup = create(&conn, &dir.0, at(0)).unwrap();
        super::super::index_note_text(&mut conn, "note", "replacement searchable", "", 1, false)
            .unwrap();

        conn.execute_batch(
            "update contents set state = X'02';
             insert into modules values ('later', 'Later');
             delete from files;",
        )
        .unwrap();
        std::fs::remove_file(&image_path).unwrap();
        std::fs::write(dir.0.join("files").join("later"), b"later").unwrap();

        restore(&mut conn, &dir.0, &backup.id, at(1)).unwrap();

        assert_eq!(state(&conn), vec![1]);
        assert_eq!(
            super::super::search(&conn, "original", 10).unwrap().len(),
            1
        );
        assert!(super::super::search(&conn, "replacement", 10)
            .unwrap()
            .is_empty());
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
        assert_eq!(
            super::super::search(&conn, "replacement", 10)
                .unwrap()
                .len(),
            1
        );
        assert!(super::super::search(&conn, "original", 10)
            .unwrap()
            .is_empty());
        assert!(dir.0.join("files").join("later").exists());
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
