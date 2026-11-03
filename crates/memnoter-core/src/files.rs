use crate::*;

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
    let app_dir = data_dir;
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
    if Uuid::parse_str(&file_id).is_err() {
        return Err("Invalid file ID".to_string());
    }

    let expected_path = data_dir.join("files").join(&file_id);
    let conn = db.lock()?;
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

pub fn resolve_card_image(data_dir: &Path, db: &Db, file_id: String) -> CommandResult<String> {
    if Uuid::parse_str(&file_id).is_err() {
        return Err("Invalid image ID".into());
    }
    let conn = db.lock()?;
    let path: String = conn
        .query_row("select path from files where id = ?1", [&file_id], |r| {
            r.get(0)
        })
        .map_err(db_err)?;
    let expected = data_dir.join("files").join(file_id);
    if Path::new(&path) != expected || !expected.is_file() {
        return Err("Image is unavailable".into());
    }
    Ok(path)
}

pub fn cleanup_unused_files(
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
    asset_refs::retain_all(conn, None)?;
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

pub fn cleanup_files(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    file_ids: Vec<String>,
    expected_state: Vec<u8>,
    expected_update_id: i64,
) -> CommandResult<Vec<String>> {
    let files_dir = data_dir.join("files");
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
