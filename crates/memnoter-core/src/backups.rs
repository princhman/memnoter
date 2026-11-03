// Snapshots of the database and images under app_data_dir/backups/<id>/, and
// restoring from them.

use super::{db_err, open_db, rewrite_file_paths, CommandResult, Db};
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
    // Newest first.
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(backups)
}

// The caller holds the database lock, so no save can land between copying the
// database and copying the images it references.
pub fn create(
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

