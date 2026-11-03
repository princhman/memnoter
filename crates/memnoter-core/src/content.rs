use crate::*;

pub fn set_module_numbering(db: &Db, module_id: String, enabled: bool) -> CommandResult<()> {
    db.lock()?
        .execute(
            "update modules set heading_numbering = ?2 where id = ?1",
            params![module_id, enabled],
        )
        .map_err(db_err)?;
    Ok(())
}

pub fn create_module(db: &Db, name: String) -> CommandResult<String> {
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

pub fn modules(db: &Db) -> CommandResult<Vec<Module>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare("select * from modules").map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Module {
                id: row.get(0)?,
                name: row.get(1)?,
                heading_numbering: row.get(2)?,
            })
        })
        .map_err(db_err)?;

    let modules = rows.collect::<Result<Vec<Module>>>().map_err(db_err)?;

    Ok(modules)
}

pub fn rename_module(db: &Db, module_id: String, name: String) -> CommandResult<()> {
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

pub fn delete_module_data(
    conn: &mut Connection,
    files_dir: &Path,
    module_id: &str,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    // Only surviving notes can retain files; the deleted history may be corrupt.
    asset_refs::retain_all(&tx, Some(module_id))?;
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

pub fn delete_module(data_dir: &Path, db: &Db, module_id: String) -> CommandResult<()> {
    let files_dir = data_dir.join("files");
    let mut conn = db.lock()?;
    delete_module_data(&mut conn, &files_dir, &module_id)
}

pub fn get_content(db: &Db, module_id: String) -> CommandResult<GetContentResponse> {
    let conn = db.lock()?;
    read_content(&conn, &module_id)
}

pub fn read_content(conn: &Connection, module_id: &str) -> CommandResult<GetContentResponse> {
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

pub fn add_update(db: &Db, module_id: String, bytes: Vec<u8>) -> CommandResult<ContentUpdate> {
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

pub fn save_compaction(
    db: &Db,
    module_id: String,
    new_state: Vec<u8>,
    update_id: i64,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    compact_content(&mut conn, &module_id, &new_state, update_id)
}

pub fn compact_content(
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
