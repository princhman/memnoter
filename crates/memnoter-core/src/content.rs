use crate::*;

pub(crate) mod module_rows {
    use crate::*;
    use rusqlite::Transaction;
    pub fn insert(tx: &Transaction<'_>, id: &str, name: &str, state: &[u8]) -> CommandResult<()> {
        tx.execute(
            "insert into modules (id, name) values (?1, ?2)",
            params![id, name],
        )
        .map_err(db_err)?;
        tx.execute(
            "insert into contents (module_id, state) values (?1, ?2)",
            params![id, state],
        )
        .map_err(db_err)?;
        tx.execute(
            "insert into search_index (module_id, title, body, math) values (?1, ?2, '', '')",
            params![id, name],
        )
        .map_err(db_err)?;
        Ok(())
    }
    pub fn rename(tx: &Transaction<'_>, id: &str, name: &str) -> CommandResult<()> {
        tx.execute(
            "update modules set name = ?2 where id = ?1",
            params![id, name],
        )
        .map_err(db_err)?;
        tx.execute(
            "update search_index set title = ?2 where module_id = ?1",
            params![id, name],
        )
        .map_err(db_err)?;
        Ok(())
    }
}

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
    let mut conn = db.lock()?;
    let conn = conn.transaction().map_err(db_err)?;
    let id = Uuid::new_v4().to_string();

    module_rows::insert(&conn, &id, &name, &[])?;

    sync::record_module(&conn, &id, sync::VaultChange::Name(&name))?;
    conn.commit().map_err(db_err)?;
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
    let mut conn = db.lock()?;
    let conn = conn.transaction().map_err(db_err)?;

    module_rows::rename(&conn, &module_id, &name)?;

    sync::record_module(&conn, &module_id, sync::VaultChange::Name(&name))?;
    conn.commit().map_err(db_err)?;
    Ok(())
}

pub fn delete_module_data(
    conn: &mut Connection,
    files_dir: &Path,
    module_id: &str,
) -> CommandResult<()> {
    delete_module_data_inner(conn, files_dir, module_id, true)
}

pub(crate) fn delete_remote_module_data(
    conn: &mut Connection,
    files_dir: &Path,
    module_id: &str,
) -> CommandResult<()> {
    delete_module_data_inner(conn, files_dir, module_id, false)
}

fn delete_module_data_inner(
    conn: &mut Connection,
    files_dir: &Path,
    module_id: &str,
    local: bool,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    // Only surviving notes can retain files; the deleted history may be corrupt.
    asset_refs::retain_all(&tx, Some(module_id))?;
    // Stored faces (including retired ones) also retain assets. Transfer shared
    // files to a surviving note; deleting the uploader must not break copies.
    files::assets::retain_card_refs(&tx, module_id)?;
    tx.execute(
        "update files set module_id = (select min(module_id) from shared_image_refs
         where file_id = files.id and module_id <> ?1)
         where module_id = ?1 and file_type <> 'application/pdf' and exists(select 1 from shared_image_refs
         where file_id = files.id and module_id <> ?1)",
        [module_id],
    )
    .map_err(db_err)?;
    // Other devices learn the new owner, or a new device would look for the
    // image under the deleted note and never download it.
    sync::publish_file_owners(&tx)?;
    let files = {
        let mut stmt = tx
            .prepare("select id from files where module_id = ?1 union select id from documents where module_id = ?1")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([module_id], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>>>().map_err(db_err)?
    };
    for id in &files {
        let is_pdf: bool = tx.query_row(
            "select exists(select 1 from documents where id=?1) or exists(select 1 from files where id=?1 and file_type='application/pdf')",
            [id], |r| r.get(0),
        ).map_err(db_err)?;
        if is_pdf {
            if local {
                sync::record_document(&tx, id, true)?;
                sync::queue_file_delete(&tx, id)?;
            }
        } else {
            sync::record_file_deleted(&tx, id)?;
        }
    }
    let files = files
        .iter()
        .map(|id| files::assets::path(files_dir.parent().ok_or("Invalid files directory")?, id))
        .collect::<CommandResult<Vec<_>>>()?;
    tx.execute("delete from files where module_id = ?1", [module_id])
        .map_err(db_err)?;
    tx.execute("delete from search_index where module_id = ?1", [module_id])
        .map_err(db_err)?;
    // Foreign keys cascade to the document snapshot and all pending updates.
    tx.execute("delete from modules where id = ?1", [module_id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;

    for path in files {
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                // The module is already deleted; report disk cleanup separately.
                eprintln!(
                    "Failed to remove deleted module image {}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(())
}

pub fn delete_module(data_dir: &Path, db: &Db, module_id: String) -> CommandResult<()> {
    let files_dir = data_dir.join("files");
    let mut conn = db.lock()?;
    // Recorded first: if deleting fails halfway, reconciling finishes it.
    sync::record_module(&conn, &module_id, sync::VaultChange::Deleted)?;
    delete_module_data(&mut conn, &files_dir, &module_id)?;
    drop(conn);
    Ok(())
}

pub fn get_content(db: &Db, module_id: String) -> CommandResult<GetContentResponse> {
    let conn = db.lock()?;
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
        .prepare("select id, file_type from files where module_id = ?1")
        .map_err(db_err)?;

    let mut files = files_stmt
        .query_map(params![&module_id], |row| {
            Ok(FileType {
                id: row.get(0)?,
                path: String::new(),
                file_type: row.get(1)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<FileType>>>()
        .map_err(db_err)?;

    for file in &mut files {
        file.path = files::assets::path(&db.data_dir, &file.id)?
            .to_str()
            .ok_or("Invalid file path")?
            .to_owned();
    }

    Ok(GetContentResponse {
        state,
        updates,
        files,
    })
}

pub fn add_update(db: &Db, module_id: String, bytes: Vec<u8>) -> CommandResult<ContentUpdate> {
    let mut conn = db.lock()?;
    // The outbox row commits with the update, so no saved edit goes unsynced.
    let tx = conn.transaction().map_err(db_err)?;

    tx.execute(
        "insert into contents_updates (module_id, bytes, created_at) values (?1, ?2, ?3)",
        params![module_id, bytes, Utc::now().timestamp_millis()],
    )
    .map_err(db_err)?;
    let id = tx.last_insert_rowid();
    sync::record_update(&tx, &module_id, &bytes)?;
    tx.commit().map_err(db_err)?;
    drop(conn);

    Ok(ContentUpdate { id, bytes })
}

pub fn save_compaction(
    db: &Db,
    module_id: String,
    new_state: Vec<u8>,
    update_id: i64,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    // Keep leases and snapshot replacement atomic. Capture intermediate saved
    // revisions before discarding them, then validate/capture the new snapshot.
    asset_refs::retain_module(&tx, &module_id)?;
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
    asset_refs::retain_module(&tx, &module_id)?;
    tx.commit().map_err(db_err)
}
