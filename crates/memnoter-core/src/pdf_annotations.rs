//! Independent per-PDF CRDT storage. Vault checkpoints are immutable, and only
//! observed checkpoints incorporated by a writer are retired.
use crate::*;
use yrs::types::ToJson;
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

pub const LOCAL_LIMIT: usize = 32 * 1024 * 1024;
pub const VAULT_LIMIT: usize = 48 * 1024 * 1024;
const UPDATES: &str = "pdfAnnotationUpdatesV1";
const DELETED: &str = "pdfAnnotationDeletedV1";
pub const STALE_GENERATION: &str = "ANNOTATION_STALE_GENERATION";

pub(crate) fn migrate(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "create table if not exists pdf_annotations(
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        state BLOB NOT NULL, revision INTEGER NOT NULL);
        create table if not exists pdf_annotation_tombstones(document_id TEXT PRIMARY KEY);",
    )
    .map_err(db_err)
}

#[derive(Debug, serde::Serialize)]
pub struct Receipt {
    state: Option<Vec<u8>>,
    revision: i64,
    generation: String,
}

fn live(conn: &Connection, id: &str) -> CommandResult<()> {
    Uuid::parse_str(id).map_err(db_err)?;
    let exists: bool = conn
        .query_row(
            "select exists(select 1 from documents where id=?1)
        and not exists(select 1 from pdf_annotation_tombstones where document_id=?1)
        and not exists(select 1 from sync_files_gone where file_id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !exists {
        return Err("Document not found or permanently deleted".into());
    }
    Ok(())
}

fn row(conn: &Connection, id: &str) -> CommandResult<(Option<Vec<u8>>, i64)> {
    Ok(conn
        .query_row(
            "select state,revision from pdf_annotations where document_id=?1",
            [id],
            |r| Ok((Some(r.get(0)?), r.get(1)?)),
        )
        .optional()
        .map_err(db_err)?
        .unwrap_or((None, 0)))
}

pub fn load_annotations(db: &Db, document_id: String) -> CommandResult<Receipt> {
    let conn = db.lock()?;
    live(&conn, &document_id)?;
    let (state, revision) = row(&conn, &document_id)?;
    let generation = db.annotation_generation.lock().map_err(db_err)?.clone();
    Ok(Receipt {
        state,
        revision,
        generation,
    })
}

fn merged<'a>(states: impl IntoIterator<Item = &'a [u8]>) -> CommandResult<Vec<u8>> {
    let doc = Doc::new();
    for state in states {
        doc.transact_mut()
            .apply_update(
                Update::decode_v1(state)
                    .map_err(|e| format!("Invalid PDF annotation update: {e}"))?,
            )
            .map_err(db_err)?;
    }
    let state = encoded(&doc);
    Ok(state)
}

// Existing oversized libraries can still reduce data; ordinary note writes
// never pass through this annotation admission boundary.
fn capacity(before: usize, after: usize, limit: usize) -> CommandResult<()> {
    if after > limit && after > before {
        return Err(
            "PDF annotation capacity exceeded. Remove annotations or PDFs before adding more."
                .into(),
        );
    }
    Ok(())
}

fn deletion_only(old: Option<&[u8]>, state: &[u8]) -> CommandResult<bool> {
    let Some(old) = old else {
        return Ok(false);
    };
    let before = Doc::new();
    before
        .transact_mut()
        .apply_update(Update::decode_v1(old).map_err(db_err)?)
        .map_err(db_err)?;
    let after = Doc::new();
    after
        .transact_mut()
        .apply_update(Update::decode_v1(state).map_err(db_err)?)
        .map_err(db_err)?;
    let a = before.transact();
    let b = after.transact();
    if b.has_missing_updates() {
        return Ok(false);
    }
    let av = a.state_vector();
    let bv = b.state_vector();
    let added: u64 = bv
        .iter()
        .map(|(client, clock)| u64::from(clock.saturating_sub(av.get(client))))
        .sum();
    if added == 0 {
        return Ok(true);
    } // CRDT delete sets add no structs.
    let roots = |txn: &yrs::Transaction<'_>| {
        txn.root_refs()
            .filter(|(key, _)| *key != "pdfAnnotationDeletions")
            .map(|(key, value)| (key.to_owned(), value.to_json(txn)))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    if roots(&a) != roots(&b) {
        return Ok(false);
    }
    drop(a);
    drop(b);
    let old_map = before.get_or_insert_map("pdfAnnotationDeletions");
    let new_map = after.get_or_insert_map("pdfAnnotationDeletions");
    let a = before.transact();
    let b = after.transact();
    let mut fresh = 0;
    for (id, value) in new_map.iter(&b) {
        if Uuid::parse_str(id).is_err() || value != Out::Any(Any::Bool(true)) {
            return Ok(false);
        }
        if old_map.get(&a, id).is_none() {
            fresh += 1;
        }
    }
    Ok(added == fresh
        && old_map
            .iter(&a)
            .all(|(id, value)| new_map.get(&b, id) == Some(value)))
}

fn store(conn: &Connection, id: &str, state: &[u8]) -> CommandResult<bool> {
    let (old, revision) = row(conn, id)?;
    if old.as_deref() == Some(state) {
        return Ok(false);
    }
    let total: i64 = conn
        .query_row(
            "select coalesce(sum(length(state)),0) from pdf_annotations",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let total = total as usize;
    if !deletion_only(old.as_deref(), state)? {
        capacity(
            total,
            total - old.as_ref().map_or(0, Vec::len) + state.len(),
            LOCAL_LIMIT,
        )?;
    }
    conn.execute(
        "insert into pdf_annotations(document_id,state,revision) values(?1,?2,?3)
        on conflict(document_id) do update set state=excluded.state,revision=excluded.revision",
        params![id, state, revision + 1],
    )
    .map_err(db_err)?;
    Ok(true)
}

fn checkpoints(doc: &Doc) -> CommandResult<Vec<(String, String, Vec<u8>)>> {
    let map = doc.get_or_insert_map(UPDATES);
    let txn = doc.transact();
    map.iter(&txn)
        .map(|(key, value)| {
            let (id, checkpoint) = key
                .split_once('/')
                .ok_or("Invalid PDF annotation checkpoint key")?;
            Uuid::parse_str(id).map_err(db_err)?;
            Uuid::parse_str(checkpoint).map_err(db_err)?;
            let Out::Any(Any::Buffer(bytes)) = value else {
                return Err("Invalid PDF annotation checkpoint bytes".into());
            };
            // Validate even orphan/deleted checkpoints: never acknowledge malformed V1 data.
            Update::decode_v1(&bytes).map_err(|e| format!("Invalid PDF annotation update: {e}"))?;
            Ok((key.to_owned(), id.to_owned(), bytes.to_vec()))
        })
        .collect()
}

fn encoded(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn publish_into(conn: &Connection, doc: &Doc, id: &str, local: &[u8]) -> CommandResult<()> {
    let observed: Vec<_> = checkpoints(doc)?
        .into_iter()
        .filter(|(_, pdf, _)| pdf == id)
        .collect();
    let mut states = vec![local];
    states.extend(observed.iter().map(|(_, _, bytes)| bytes.as_slice()));
    let state = merged(states)?;
    store(conn, id, &state)?;
    // A single equivalent checkpoint already represents this state.
    if observed.len() == 1 && observed[0].2 == state {
        return Ok(());
    }
    let map = doc.get_or_insert_map(UPDATES);
    let mut txn = doc.transact_mut();
    for (key, _, _) in observed {
        map.remove(&mut txn, &key);
    }
    map.insert(
        &mut txn,
        format!("{id}/{}", Uuid::new_v4()),
        Any::Buffer(state.into()),
    );
    Ok(())
}

pub fn save_annotation_update(
    db: &Db,
    document_id: String,
    bytes: Vec<u8>,
    generation: String,
) -> CommandResult<Receipt> {
    let mut conn = db.lock()?;
    if *db.annotation_generation.lock().map_err(db_err)? != generation {
        return Err(STALE_GENERATION.into());
    }
    live(&conn, &document_id)?;
    if bytes.len() > VAULT_LIMIT {
        return Err("PDF annotation capacity exceeded (48 MiB input)".into());
    }
    let tx = conn.transaction().map_err(db_err)?;
    let (old, _) = row(&tx, &document_id)?;
    let state = merged(
        old.as_deref()
            .into_iter()
            .chain(std::iter::once(bytes.as_slice())),
    )?;
    let changed = store(&tx, &document_id, &state)?;
    if changed && sync::is_enabled(&tx)? {
        let doc = sync::load_vault(&tx)?;
        let before = encoded(&doc).len();
        publish_into(&tx, &doc, &document_id, &state)?;
        if !deletion_only(old.as_deref(), &state)? {
            capacity(before, encoded(&doc).len(), VAULT_LIMIT)?;
        }
        sync::save_vault(&tx, &doc)?;
        sync::push_outbox(&tx, sync::VAULT_DOC, &encoded(&doc))?;
    }
    let (state, revision) = row(&tx, &document_id)?;
    tx.commit().map_err(db_err)?;
    Ok(Receipt {
        state,
        revision,
        generation,
    })
}

pub(crate) fn tombstones(conn: &Connection) -> CommandResult<Vec<String>> {
    conn.prepare("select document_id from pdf_annotation_tombstones")
        .map_err(db_err)?
        .query_map([], |r| r.get(0))
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)
}

pub(crate) fn retire(conn: &Connection, id: &str) -> CommandResult<()> {
    conn.execute(
        "insert or ignore into pdf_annotation_tombstones values(?1)",
        [id],
    )
    .map_err(db_err)?;
    conn.execute("delete from pdf_annotations where document_id=?1", [id])
        .map_err(db_err)?;
    Ok(())
}

fn seed_deleted(conn: &Connection, doc: &Doc) -> CommandResult<()> {
    let deleted = doc.get_or_insert_map(DELETED);
    let updates = doc.get_or_insert_map(UPDATES);
    let keys = checkpoints(doc)?;
    let ids = tombstones(conn)?;
    let mut txn = doc.transact_mut();
    for id in ids {
        if deleted.get(&txn, &id) != Some(Out::Any(Any::Bool(true))) {
            deleted.insert(&mut txn, id.as_str(), true);
        }
        for (key, pdf, _) in &keys {
            if pdf == &id {
                updates.remove(&mut txn, key);
            }
        }
    }
    Ok(())
}

pub(crate) fn seed(conn: &Connection, doc: &Doc) -> CommandResult<()> {
    reconcile(conn, doc)?;
    let before = Doc::new();
    before
        .transact_mut()
        .apply_update(Update::decode_v1(&encoded(doc)).map_err(db_err)?)
        .map_err(db_err)?;
    let rows = conn
        .prepare("select document_id,state from pdf_annotations")
        .map_err(db_err)?
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>>>()
        .map_err(db_err)?;
    for (id, state) in &rows {
        publish_into(conn, doc, id, state)?;
    }
    seed_deleted(conn, doc)?;
    if !rows.is_empty() {
        admit_incoming(&before, doc)?;
    }
    Ok(())
}

pub(crate) fn publish_deleted(conn: &Connection, id: &str) -> CommandResult<()> {
    retire(conn, id)?;
    if sync::is_enabled(conn)? {
        let doc = sync::load_vault(conn)?;
        seed_deleted(conn, &doc)?;
        sync::save_vault(conn, &doc)?;
        sync::push_outbox(conn, sync::VAULT_DOC, &encoded(&doc))?;
    }
    Ok(())
}

pub(crate) fn admit_incoming(before: &Doc, after: &Doc) -> CommandResult<()> {
    let group = |doc: &Doc| -> CommandResult<std::collections::BTreeMap<String, Vec<Vec<u8>>>> {
        let mut grouped = std::collections::BTreeMap::<String, Vec<Vec<u8>>>::new();
        for (_, id, bytes) in checkpoints(doc)? {
            grouped.entry(id).or_default().push(bytes);
        }
        Ok(grouped)
    };
    let old = group(before)?;
    let new = group(after)?;
    for (id, states) in new {
        let state = merged(states.iter().map(Vec::as_slice))?;
        let previous = old
            .get(&id)
            .map(|v| merged(v.iter().map(Vec::as_slice)))
            .transpose()?;
        if previous.as_deref() != Some(state.as_slice())
            && !deletion_only(previous.as_deref(), &state)?
        {
            capacity(encoded(before).len(), encoded(after).len(), VAULT_LIMIT)?;
            break;
        }
    }
    Ok(())
}

/// Materialization never publishes: receiving/consolidating cannot echo forever.
pub(crate) fn reconcile(conn: &Connection, doc: &Doc) -> CommandResult<Vec<String>> {
    let entries = checkpoints(doc)?;
    let deleted = doc.get_or_insert_map(DELETED);
    let mut ids = tombstones(conn)?;
    {
        let txn = doc.transact();
        for (id, value) in deleted.iter(&txn) {
            Uuid::parse_str(id).map_err(db_err)?;
            if value != Out::Any(Any::Bool(true)) {
                return Err("Invalid PDF annotation tombstone".into());
            }
            ids.push(id.to_owned());
        }
    }
    ids.extend(sync::deleted_annotation_documents(conn, doc)?);
    ids.sort();
    ids.dedup();
    let mut changed = Vec::new();
    for id in ids {
        let known: bool = conn
            .query_row(
                "select exists(select 1 from pdf_annotation_tombstones where document_id=?1)",
                [&id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !known || row(conn, &id)?.0.is_some() {
            changed.push(id.clone());
        }
        retire(conn, &id)?;
    }
    let mut grouped = std::collections::BTreeMap::<String, Vec<Vec<u8>>>::new();
    for (_, id, bytes) in entries {
        grouped.entry(id).or_default().push(bytes);
    }
    for (id, mut states) in grouped {
        if live(conn, &id).is_err() {
            continue;
        }
        if let Some(old) = row(conn, &id)?.0 {
            states.push(old);
        }
        let state = merged(states.iter().map(Vec::as_slice))?;
        if store(conn, &id, &state)? {
            changed.push(id);
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_exemption_accepts_deletions_but_not_new_or_pending_content() {
        let doc = Doc::new();
        let map = doc.get_or_insert_map("pdfAnnotations");
        map.insert(&mut doc.transact_mut(), "existing", "content");
        let before = encoded(&doc);
        let deleted = doc.get_or_insert_map("pdfAnnotationDeletions");
        deleted.insert(&mut doc.transact_mut(), Uuid::new_v4().to_string(), true);
        assert!(deletion_only(Some(&before), &encoded(&doc)).unwrap());
        map.insert(&mut doc.transact_mut(), "new", "content");
        assert!(!deletion_only(Some(&before), &encoded(&doc)).unwrap());

        let vector = doc.transact().state_vector();
        map.insert(&mut doc.transact_mut(), "pending", "not received yet");
        let incremental = doc.transact().encode_state_as_update_v1(&vector);
        let pending = merged([before.as_slice(), incremental.as_slice()]).unwrap();
        assert!(!deletion_only(Some(&before), &pending).unwrap());
        map.remove(&mut doc.transact_mut(), "existing");
        let full_before = encoded(&doc);
        map.remove(&mut doc.transact_mut(), "new");
        assert!(deletion_only(Some(&full_before), &encoded(&doc)).unwrap());
    }

    #[test]
    fn capacity_allows_exact_limits_and_reductions() {
        for limit in [LOCAL_LIMIT, VAULT_LIMIT] {
            assert!(capacity(0, limit, limit).is_ok());
            assert!(capacity(0, limit + 1, limit).is_err());
            assert!(capacity(limit + 2, limit + 1, limit).is_ok());
        }
    }
}
