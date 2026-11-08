use crate::*;
use std::io::Read;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: String,
    pub module_id: String,
    pub module_name: String,
    pub name: String,
    pub size: i64,
    pub page_count: Option<i64>,
    pub created_at: i64,
    pub available: bool,
}

pub(crate) fn migrate(conn: &Connection) -> CommandResult<()> {
    // Metadata can sync before bytes, so id deliberately has no files foreign key.
    conn.execute_batch(
        "create table if not exists documents (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        page_count INTEGER NULL,
        created_at INTEGER NOT NULL
    ); create index if not exists documents_module on documents(module_id);",
    )
    .map_err(db_err)
}

fn max_file_bytes() -> u64 {
    let contract: serde_json::Value = serde_json::from_str(include_str!(
        "../../../apps/sync/test/fixtures/protocol.json"
    ))
    .expect("valid wire contract");
    contract["MAX_FILE_BYTES"].as_u64().expect("file limit")
}

fn validate_size(size: u64) -> CommandResult<()> {
    if size > max_file_bytes() {
        let mb = (size as f64 / (1024.0 * 1024.0)).round() as u64;
        return Err(format!("This PDF is {mb} MB. The limit is 50 MB. Try a PDF compression tool to reduce its size."));
    }
    Ok(())
}

pub fn add_document(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    path: String,
) -> CommandResult<DocumentRecord> {
    let path = Path::new(&path);
    let file = std::fs::File::open(path).map_err(db_err)?;
    validate_size(file.metadata().map_err(db_err)?.len())?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid PDF name")?
        .to_owned();
    // Bound the read too, in case the source grows after the metadata check.
    let mut bytes = Vec::new();
    file.take(max_file_bytes() + 1)
        .read_to_end(&mut bytes)
        .map_err(db_err)?;
    add_document_bytes(data_dir, db, module_id, name, bytes)
}

pub fn add_document_bytes(
    data_dir: &Path,
    db: &Db,
    module_id: String,
    name: String,
    bytes: Vec<u8>,
) -> CommandResult<DocumentRecord> {
    validate_size(bytes.len() as u64)?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("This file is not a PDF".into());
    }
    let id = Uuid::new_v4().to_string();
    let conn = db.lock()?;
    conn.query_row("select id from modules where id = ?1", [&module_id], |r| {
        r.get::<_, String>(0)
    })
    .map_err(db_err)?;
    let path = files::assets::write(data_dir, &id, &bytes)?;
    let inserted = (|| -> CommandResult<()> {
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "insert into files(id,module_id,path,file_type) values (?1,?2,?3,'application/pdf')",
            params![id, module_id, path.to_string_lossy()],
        )
        .map_err(db_err)?;
        tx.execute(
            "insert into documents(id,module_id,name,size,created_at) values (?1,?2,?3,?4,?5)",
            params![
                id,
                module_id,
                name,
                bytes.len() as i64,
                Utc::now().timestamp_millis()
            ],
        )
        .map_err(db_err)?;
        // Not in the vault's image list: older builds would download every PDF,
        // delete it as an unused image and fetch it again on each launch.
        if sync::is_enabled(&tx)? {
            tx.execute("insert or ignore into sync_file_uploads (file_id) values (?1)", [&id])
                .map_err(db_err)?;
        }
        sync::record_document(&tx, &id, false)?;
        tx.commit().map_err(db_err)
    })();
    if let Err(error) = inserted {
        std::fs::remove_file(path)
            .map_err(|cleanup| format!("{error}. File cleanup also failed: {cleanup}"))?;
        return Err(error);
    }
    document_record(data_dir, &conn, &id)
}

const SELECT_DOCUMENT: &str =
    "select d.id,d.module_id,m.name,d.name,d.size,d.page_count,d.created_at
    from documents d join modules m on m.id=d.module_id";

fn from_row(row: &rusqlite::Row<'_>) -> Result<DocumentRecord> {
    Ok(DocumentRecord {
        id: row.get(0)?,
        module_id: row.get(1)?,
        module_name: row.get(2)?,
        name: row.get(3)?,
        size: row.get(4)?,
        page_count: row.get(5)?,
        created_at: row.get(6)?,
        available: false,
    })
}

fn with_availability(data_dir: &Path, mut record: DocumentRecord) -> CommandResult<DocumentRecord> {
    record.available = files::assets::path(data_dir, &record.id)?.is_file();
    Ok(record)
}

fn records(
    data_dir: &Path,
    conn: &Connection,
    module_id: Option<&str>,
) -> CommandResult<Vec<DocumentRecord>> {
    conn.prepare(&format!(
        "{SELECT_DOCUMENT} where ?1 is null or d.module_id=?1
        order by d.created_at desc,d.id desc"
    ))
    .map_err(db_err)?
    .query_map([module_id], from_row)
    .map_err(db_err)?
    .map(|row| with_availability(data_dir, row.map_err(db_err)?))
    .collect()
}

fn document_record(data_dir: &Path, conn: &Connection, id: &str) -> CommandResult<DocumentRecord> {
    let record = conn
        .query_row(&format!("{SELECT_DOCUMENT} where d.id=?1"), [id], from_row)
        .optional()
        .map_err(db_err)?
        .ok_or("Document not found")?;
    with_availability(data_dir, record)
}

pub fn list_documents(
    data_dir: &Path,
    db: &Db,
    module_id: Option<String>,
) -> CommandResult<Vec<DocumentRecord>> {
    records(data_dir, &*db.lock()?, module_id.as_deref())
}

pub fn rename_document(db: &Db, id: String, name: String) -> CommandResult<()> {
    let conn = db.lock()?;
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    if tx
        .execute(
            "update documents set name=?2 where id=?1",
            params![id, name],
        )
        .map_err(db_err)?
        == 0
    {
        return Err("Document not found".into());
    }
    sync::record_document(&tx, &id, false)?;
    tx.commit().map_err(db_err)
}

pub fn set_document_page_count(db: &Db, id: String, page_count: i64) -> CommandResult<()> {
    if page_count < 1 {
        return Err("Page count must be positive".into());
    }
    if db
        .lock()?
        .execute(
            "update documents set page_count=?2 where id=?1",
            params![id, page_count],
        )
        .map_err(db_err)?
        == 0
    {
        return Err("Document not found".into());
    }
    Ok(())
}

pub(crate) fn remove_local(data_dir: &Path, conn: &Connection, id: &str) -> CommandResult<()> {
    let path = files::assets::path(data_dir, id)?;
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    tx.execute("delete from documents where id=?1", [id])
        .map_err(db_err)?;
    // TODO(#29): record the file tombstone here when the shared hook is available.
    tx.execute("delete from files where id=?1", [id])
        .map_err(db_err)?;
    tx.execute("delete from sync_file_uploads where file_id=?1", [id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(db_err(e)),
    }
}

pub fn delete_document(data_dir: &Path, db: &Db, id: String) -> CommandResult<()> {
    files::assets::path(data_dir, &id)?;
    let conn = db.lock()?;
    document_record(data_dir, &conn, &id)?;
    // Persist the tombstone first; reconcile can retry disk cleanup after a crash.
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    sync::record_document(&tx, &id, true)?;
    tx.commit().map_err(db_err)?;
    remove_local(data_dir, &conn, &id)
}

pub fn document_path(data_dir: &Path, db: &Db, id: String) -> CommandResult<String> {
    let conn = db.lock()?;
    let record = document_record(data_dir, &conn, &id)?;
    if !record.available {
        return Err("PDF is unavailable".into());
    }
    std::fs::canonicalize(files::assets::path(data_dir, &id)?)
        .map_err(db_err)?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "File path is not valid UTF-8".into())
}
