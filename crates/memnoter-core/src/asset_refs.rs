//! Durable leases for shared images. A foreign note retains a lease until that
//! note is deleted, including after undo, image removal and Yjs compaction.
use crate::{db_err, CommandResult};
use rusqlite::{params, Connection};
use yrs::{updates::decoder::Decode, Doc, ReadTxn, Transact, Update};

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
pub fn retain_module(
    conn: &Connection,
    module_id: &str,
) -> CommandResult<std::collections::HashSet<String>> {
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
    let foreign = conn
        .prepare("select id from files where module_id <> ?1")
        .map_err(db_err)?
        .query_map([module_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    let canonical: std::collections::HashSet<&str> = foreign
        .iter()
        .filter(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok())
        .map(String::as_str)
        .collect();
    let legacy: Vec<&str> = foreign
        .iter()
        .map(String::as_str)
        .filter(|id| !canonical.contains(id) && !id.is_empty())
        .collect();
    for (index, bytes) in std::iter::once(state).chain(updates).enumerate() {
        let mut deletions = None;
        if !bytes.is_empty() {
            let update = Update::decode_v1(&bytes).map_err(db_err)?;
            if index > 0 {
                deletions = Some(update.delete_set().clone());
            }
            doc.transact_mut().apply_update(update).map_err(db_err)?;
        }
        let txn = doc.transact();
        // A self-contained update can introduce structs and delete some of
        // them in the same payload. Validate against the state after applying
        // that payload, while still rejecting deletes whose inserts are absent.
        if let Some(deletions) = deletions {
            let known = txn.state_vector();
            if deletions
                .iter()
                .any(|(client, ranges)| ranges.iter().any(|range| range.end > known.get(client)))
            {
                return Err(format!(
                    "Out-of-order persisted image deletions in module {module_id}"
                ));
            }
        }
        // An early delete may hide a later insertion before it ever appears in
        // the visible tree. A complete final state does not prove undo safety.
        if txn.has_missing_updates() {
            return Err(format!(
                "Out-of-order persisted image history in module {module_id}"
            ));
        }
        // Version-1 Yjs strings are UTF-8 in the payload. Lease known foreign
        // asset IDs even when their items are deleted by that same payload:
        // they may still be held by the producer's live undo manager. Looking
        // only at the final visible XML tree would miss those references.
        let mut encoded_assets = std::collections::HashSet::new();
        for candidate in bytes.windows(36) {
            if [8, 13, 18, 23]
                .iter()
                .all(|&index| candidate[index] == b'-')
            {
                if let Ok(id) = std::str::from_utf8(candidate) {
                    if canonical.contains(id) {
                        encoded_assets.insert(id);
                    }
                }
            }
        }
        for id in &legacy {
            if bytes.windows(id.len()).any(|part| part == id.as_bytes()) {
                encoded_assets.insert(*id);
            }
        }
        for id in encoded_assets {
            conn.execute(
                "insert or ignore into shared_image_refs (module_id, file_id) values (?1, ?2)",
                params![module_id, id],
            )
            .map_err(db_err)?;
        }
        drop(txn);
        let txn = doc.transact();
        for id in crate::files::assets::note_images(&root, &txn) {
            conn.execute(
                "insert or ignore into shared_image_refs (module_id, file_id)
                 select ?1, id from files where id = ?2 and module_id <> ?1",
                params![module_id, id],
            )
            .map_err(db_err)?;
        }
    }
    if doc.transact().has_missing_updates() {
        return Err(format!(
            "Incomplete persisted image references in module {module_id}"
        ));
    }
    let mut current_assets = crate::files::assets::note_images(&root, &doc.transact());
    match crate::worksheets::document_assets(&doc) {
        Ok(assets) => current_assets.extend(assets),
        Err(_) => current_assets.extend(
            conn.prepare("select id from files")
                .map_err(db_err)?
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(db_err)?,
        ),
    }
    for id in &current_assets {
        conn.execute("update worksheet_asset_leases set pending=0 where module_id=?1 and file_id=?2",
            params![module_id,id]).map_err(db_err)?;
        // Own note images are protected by the current-tree check. Only
        // worksheet/future roots need durable session leases for same-owner IDs.
        if doc.transact().root_refs().any(|(name, _)| name != "default") {
            retain_worksheet_asset(conn, module_id, id, false)?;
        }
    }
    Ok(current_assets)
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

// PDFs can be source provenance for worksheets or unknown future roots.
pub(crate) fn is_leased(conn: &Connection, id: &str) -> CommandResult<bool> {
    retain_all(conn, None)?;
    let modules = conn
        .prepare("select module_id from shared_image_refs where file_id=?1")
        .map_err(db_err)?
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    for module in modules {
        if !matches!(
            crate::worksheets::read(&crate::worksheets::load(conn, &module)?),
            Ok(None)
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Worksheet leases have a session lifetime after publication, so answer undo
/// remains usable even after compaction. Pending uploads survive process death
/// until an answer containing them is durable (including local draft recovery).
/// Unlike foreign-note undo leases, published worksheet leases are rebuilt at
/// startup, when there is no live undo manager. Historical pinned crops and
/// canvas copies are still current document references and remain protected.
pub(crate) fn migrate_worksheet_leases(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch("create table if not exists worksheet_asset_leases (
        module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        pending INTEGER NOT NULL,
        PRIMARY KEY(module_id,file_id)
    );
    insert or ignore into worksheet_asset_leases
        select r.module_id,r.file_id,0 from shared_image_refs r join files f
        on f.id=r.file_id and f.module_id=r.module_id;") .map_err(db_err)
}

pub(crate) fn retain_worksheet_asset(conn: &Connection, module: &str, file: &str, pending: bool) -> CommandResult<()> {
    conn.execute("insert or ignore into shared_image_refs(module_id,file_id)
        select ?1,id from files where id=?2", params![module,file]).map_err(db_err)?;
    conn.execute("insert into worksheet_asset_leases(module_id,file_id,pending)
        select ?1,id,?3 from files where id=?2 and module_id=?1
        on conflict(module_id,file_id) do update set pending=min(pending,excluded.pending)",
        params![module,file,pending]).map_err(db_err)?;
    Ok(())
}

pub(crate) fn refresh_worksheet_leases(conn: &Connection) -> CommandResult<()> {
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    tx.execute("delete from shared_image_refs where exists (
        select 1 from worksheet_asset_leases w where w.module_id=shared_image_refs.module_id
        and w.file_id=shared_image_refs.file_id and w.pending=0)", []).map_err(db_err)?;
    tx.execute("delete from worksheet_asset_leases where pending=0", []).map_err(db_err)?;
    let modules = tx.prepare("select module_id from contents").map_err(db_err)?
        .query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    for module in modules {
        let assets = match crate::worksheets::load(&tx, &module)
            .and_then(|doc| {
                let mut assets = crate::worksheets::document_assets(&doc)?;
                let txn = doc.transact();
                if let Some(root) = txn.get_xml_fragment("default") {
                    assets.extend(crate::files::assets::note_images(&root, &txn));
                }
                Ok(assets)
            }) {
            Ok(assets) => assets,
            Err(_) => tx.prepare("select id from files").map_err(db_err)?
                .query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?
                .collect::<rusqlite::Result<_>>().map_err(db_err)?,
        };
        for file in assets { retain_worksheet_asset(&tx, &module, &file, false)?; }
    }
    tx.commit().map_err(db_err)
}

// Publication may arrive before or after file bytes. Promote only references in
// a complete, understood durable document; unknown/incomplete updates stay leased.
pub(crate) fn publish_current(conn: &Connection, module: &str) -> CommandResult<()> {
    let Ok(doc) = crate::worksheets::load(conn, module) else { return Ok(()); };
    let Ok(mut assets) = crate::worksheets::document_assets(&doc) else { return Ok(()); };
    let txn = doc.transact();
    if let Some(root) = txn.get_xml_fragment("default") {
        assets.extend(crate::files::assets::note_images(&root, &txn));
    }
    for file in assets { retain_worksheet_asset(conn, module, &file, false)?; }
    Ok(())
}
