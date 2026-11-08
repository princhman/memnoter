use crate::*;

pub(crate) mod assets {
    use crate::*;
    use std::io::Write;
    pub fn path(data_dir: &Path, id: &str) -> CommandResult<PathBuf> {
        Uuid::parse_str(id).map_err(|_| "Invalid file ID".to_string())?;
        Ok(data_dir.join("files").join(id))
    }
    pub fn write(data_dir: &Path, id: &str, bytes: &[u8]) -> CommandResult<PathBuf> {
        let path = path(data_dir, id)?;
        if path.exists() {
            return Err("Asset already exists".into());
        }
        let partial = path.with_extension("partial");
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            std::fs::rename(&partial, &path)?;
            std::fs::File::open(data_dir.join("files"))?.sync_all()
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(db_err(error));
        }
        Ok(path)
    }
    pub fn note_images(
        root: &yrs::XmlFragmentRef,
        txn: &impl yrs::ReadTxn,
    ) -> std::collections::HashSet<String> {
        use yrs::{Any, Out, Xml, XmlFragment, XmlOut};
        root.successors(txn)
            .filter_map(|node| {
                if let XmlOut::Element(element) = node {
                    if let Some(Out::Any(Any::String(id))) = element.get_attribute(txn, "fileId") {
                        return Some(id.to_string());
                    }
                }
                None
            })
            .collect()
    }
    pub fn retain_card_refs(conn: &Connection, excluded_module: &str) -> CommandResult<()> {
        conn.execute(
            "insert or ignore into shared_image_refs(module_id, file_id)
         select cards.module_id, files.id from cards join files
         on files.id = json_extract(cards.front, '$.fileId')
         or files.id = json_extract(cards.back, '$.fileId')
         where cards.kind = 'occlusion' and cards.module_id <> ?1",
            [excluded_module],
        )
        .map_err(db_err)?;
        Ok(())
    }
    pub fn referenced_by(conn: &Connection, id: &str) -> CommandResult<bool> {
        conn.query_row(
            "select exists(select 1 from shared_image_refs where file_id = ?1)
            or exists(select 1 from cards where kind = 'occlusion'
            and (json_extract(front, '$.fileId') = ?1 or json_extract(back, '$.fileId') = ?1))",
            [id],
            |r| r.get(0),
        )
        .map_err(db_err)
    }
    pub fn card_image<'a>(
        kind: &str,
        front: &'a serde_json::Value,
        back: &'a serde_json::Value,
    ) -> Option<&'a str> {
        if kind != "occlusion" {
            return None;
        }
        let id = front.get("fileId")?.as_str()?;
        (back.get("fileId")?.as_str()? == id).then_some(id)
    }

    // Only at startup, before uploads can run. Leases reference file rows, so a
    // managed UUID with no row cannot belong to any saved note or undo history.
    pub fn cleanup_orphans(conn: &Connection, files_dir: &Path) -> CommandResult<()> {
        for entry in std::fs::read_dir(files_dir).map_err(db_err)? {
            let entry = entry.map_err(db_err)?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = id.strip_suffix(".partial") {
                if Uuid::parse_str(id).is_ok() && entry.file_type().map_err(db_err)?.is_file() {
                    std::fs::remove_file(entry.path()).map_err(db_err)?;
                    continue;
                }
            }
            if !entry.file_type().map_err(db_err)?.is_file() || Uuid::parse_str(&id).is_err() {
                continue;
            }
            let exists: bool = conn
                .query_row(
                    "select exists(select 1 from files where id = ?1)",
                    [&id],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if !exists {
                std::fs::remove_file(entry.path()).map_err(db_err)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, serde::Serialize)]
pub struct FileContents {
    bytes: Vec<u8>,
    file_type: String,
}
pub fn save_file(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> CommandResult<FileType> {
    let id = Uuid::new_v4().to_string();
    let path = assets::path(data_dir, &id)?;

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

    assets::write(data_dir, &id, &bytes)?;

    // ai-suggested error handling - cleanup if failed
    // The file row and its upload record commit together.
    let inserted = (|| -> CommandResult<()> {
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "insert into files (id, module_id, path, file_type)
             values (?1, ?2, ?3, ?4)",
            params![id, module_id, path_str, mime_type],
        )
        .map_err(db_err)?;
        sync::record_file(&tx, &id, &module_id, &mime_type)?;
        tx.commit().map_err(db_err)
    })();
    if let Err(error) = inserted {
        if let Err(cleanup_error) = std::fs::remove_file(&path) {
            return Err(format!(
                "Database insert failed: {error}. \
                 File cleanup also failed: {cleanup_error}"
            ));
        }

        return Err(db_err(error));
    }
    drop(conn);

    Ok(FileType {
        id,
        path: path_str.to_owned(),
        file_type: mime_type,
    })
}

pub fn read_file(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    file_id: String,
) -> CommandResult<FileContents> {
    let _ = module_id; // Copied images may refer to another note's managed asset.
    let expected_path = assets::path(data_dir, &file_id)?;
    let conn = db.lock()?;
    let file_type: String = conn
        .query_row(
            "select file_type from files where id = ?1",
            [&file_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;

    let bytes = std::fs::read(expected_path).map_err(db_err)?;
    Ok(FileContents { bytes, file_type })
}

pub fn resolve_card_image(data_dir: &Path, db: &Db, file_id: String) -> CommandResult<String> {
    let expected = assets::path(data_dir, &file_id)?;
    let conn = db.lock()?;
    conn.query_row("select id from files where id = ?1", [&file_id], |r| {
        r.get::<_, String>(0)
    })
    .map_err(db_err)?;
    if !expected.is_file() {
        return Err("Image is unavailable".into());
    }
    Ok(expected.to_string_lossy().into_owned())
}

pub fn cleanup_files(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    file_ids: Vec<String>,
    expected_state: Vec<u8>,
    expected_update_id: i64,
) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    let module_id = module_id.as_str();
    let file_ids = &file_ids;
    let expected_state = expected_state.as_slice();
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
    asset_refs::retain_all(&conn, None)?;
    let mut deleted = Vec::new();
    for id in file_ids {
        // Retain even retired faces: undo restores their ids/history and assets.
        let referenced = assets::referenced_by(&conn, id)?;
        if referenced {
            continue;
        }
        let path: Option<String> = conn
            .query_row(
                "select id from files where id = ?1 and module_id = ?2",
                params![id, module_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(_) = path else { continue };
        let path = assets::path(data_dir, id)?;
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
