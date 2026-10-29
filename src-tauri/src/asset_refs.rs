//! Durable leases for shared images. A foreign note retains a lease until that
//! note is deleted, including after undo, image removal and Yjs compaction.
use crate::{db_err, CommandResult};
use rusqlite::{params, Connection};
use yrs::{
    updates::decoder::Decode, Any, Doc, Out, ReadTxn, Transact, Update, Xml, XmlFragment, XmlOut,
};

pub fn migrate(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "create table if not exists shared_image_refs (
            module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
            file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            PRIMARY KEY(module_id, file_id)
        );
        create index if not exists shared_image_refs_file on shared_image_refs(file_id);",
    )
    .map_err(db_err)
}

// Replay every persisted revision, not just the final tree: a foreign image
// removed before compaction may still be recoverable by the live undo manager.
pub fn retain_module(conn: &Connection, module_id: &str) -> CommandResult<()> {
    let state: Vec<u8> = conn
        .query_row(
            "select state from contents where module_id = ?1",
            [module_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let mut stmt = conn
        .prepare("select bytes from contents_updates where module_id = ?1 order by id")
        .map_err(db_err)?;
    let updates = stmt
        .query_map([module_id], |r| r.get::<_, Vec<u8>>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    let doc = Doc::new();
    let root = doc.get_or_insert_xml_fragment("default");
    for (index, bytes) in std::iter::once(state).chain(updates).enumerate() {
        if !bytes.is_empty() {
            let update = Update::decode_v1(&bytes).map_err(db_err)?;
            if index > 0 {
                let known = doc.transact().state_vector();
                // Do not let a delete conceal content that has never been
                // observed in a preceding persisted revision, even if the
                // decoder does not retain that deletion as pending.
                if update.delete_set().iter().any(|(client, ranges)| {
                    ranges.iter().any(|range| range.end > known.get(client))
                }) {
                    return Err(format!(
                        "Out-of-order persisted image deletions in module {module_id}"
                    ));
                }
            }
            doc.transact_mut().apply_update(update).map_err(db_err)?;
        }
        let txn = doc.transact();
        // An early delete may hide a later insertion before it ever appears in
        // the visible tree. A complete final state does not prove undo safety.
        if txn.has_missing_updates() {
            return Err(format!(
                "Out-of-order persisted image history in module {module_id}"
            ));
        }
        for node in root.successors(&txn) {
            if let XmlOut::Element(element) = node {
                if let Some(Out::Any(Any::String(id))) = element.get_attribute(&txn, "fileId") {
                    conn.execute(
                        "insert or ignore into shared_image_refs (module_id, file_id)
                         select ?1, id from files where id = ?2 and module_id <> ?1",
                        params![module_id, id.as_ref()],
                    )
                    .map_err(db_err)?;
                }
            }
        }
    }
    if doc.transact().has_missing_updates() {
        return Err(format!(
            "Incomplete persisted image references in module {module_id}"
        ));
    }
    Ok(())
}

// Also bootstraps older notes that have never been opened by this version.
// Caller holds the same DB lock used by saves/deletion for the entire operation.
pub fn retain_all(conn: &Connection, excluded_module: Option<&str>) -> CommandResult<()> {
    let modules = conn
        .prepare("select module_id from contents where ?1 is null or module_id <> ?1")
        .map_err(db_err)?
        .query_map([excluded_module], |r| r.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    for module in modules {
        retain_module(conn, &module)?;
    }
    Ok(())
}
