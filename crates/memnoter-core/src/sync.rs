//! Local half of cloud sync. The frontend's sync engine moves data between
//! these tables and the server; everything here is plaintext and local.
//!
//! - `sync_outbox` holds local Yjs updates the server has not acknowledged,
//!   oldest first. Rows are written in the same transaction as the change.
//! - `sync_state` holds the account, the cursor (highest server seq applied)
//!   and the vault: a Yjs document with the module list, so renames and
//!   deletions merge like note text. Keys are "<module id>.name" (string) and
//!   "<module id>.deleted" (true). Deletion is permanent.
//!
//! - Review history: one Yjs document per module, "r-<module id>", stored in
//!   `sync_docs`. Map "cards" holds each reviewed card's FSRS state as JSON
//!   (the latest write wins); map "log" holds review log rows by `sync_id`, with
//!   "" marking a review that was undone.
//! - Images: the vault's "files" map records each file's module and type, and
//!   `sync_file_uploads` queues files to upload. Other devices download what
//!   they are missing; the bytes go to R2, encrypted, not through the log.
//!   Removed files retain tombstones; sync_file_deletes queues R2 deletion
//!   until the vault outbox is acknowledged.
//! - An outbox entry with empty bytes asks the server to forget the document.
//!
//! Nothing is recorded while sync is off; turning it on seeds the outbox with
//! everything stored locally.
pub mod crypto;
pub mod session;

use crate::{db_err, section_moves, CommandResult, ContentUpdate, Db};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

pub const VAULT_DOC: &str = "vault";
const MODULES_MAP: &str = "modules";
const MODULE_DELETIONS_MAP: &str = "moduleDeletions";
const FILES_MAP: &str = "files";
const REVIEW_PREFIX: &str = "r-";
const CARRIED_REVIEWS_PREFIX: &str = "r-carried-";
const REVIEW_CARDS_MAP: &str = "cards";
const REVIEW_LOG_MAP: &str = "log";

pub fn review_doc_id(module_id: &str) -> String {
    format!("{REVIEW_PREFIX}{module_id}")
}

fn carried_reviews_id(module_id: &str) -> String {
    format!("{CARRIED_REVIEWS_PREFIX}{module_id}")
}

// A legacy note delete can drop r-<module>. Its encrypted review history
// must also have an address that a note deletion cannot name.
pub(crate) fn carry_reviews(conn: &Connection, module: &str) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    let doc = load_doc(conn, &review_doc_id(module))?;
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    push_outbox(conn, &carried_reviews_id(module), &state)
}

// Card state and review log rows as JSON, for the review documents.
fn json_object_sql(fields: &[&str]) -> String {
    format!(
        "json_object({})",
        fields
            .iter()
            .map(|field| format!("'{field}', {field}"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}
fn card_state_json() -> String {
    json_object_sql(crate::cards::CARD_STATE_FIELDS)
}
fn log_json() -> String {
    let mut fields = vec![
        "card_id",
        "rating",
        "review_time",
        "duration_ms",
        "fsrs_model",
    ];
    fields.extend_from_slice(&crate::cards::CARD_STATE_FIELDS[..9]);
    json_object_sql(&fields)
}
pub const OUTBOX_EVENT: &str = "sync-outbox";

pub fn migrate(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "create table if not exists sync_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc TEXT NOT NULL,
            bytes BLOB NOT NULL
        );
        create table if not exists sync_state (
            key TEXT PRIMARY KEY,
            value
        );
        create table if not exists sync_docs (
            doc TEXT PRIMARY KEY,
            state BLOB NOT NULL
        );
        create table if not exists sync_files_gone (
            file_id TEXT PRIMARY KEY
        );
        create table if not exists sync_file_deletes (
            file_id TEXT PRIMARY KEY
        );
        create table if not exists sync_file_uploads (
            file_id TEXT PRIMARY KEY
        );",
    )
    .map_err(db_err)?;
    crate::db::ensure_column(conn, "review_log", "sync_id", "TEXT")?;
    conn.execute_batch(
        "create unique index if not exists review_log_sync_id on review_log(sync_id) where sync_id is not null;",
    )
    .map_err(db_err)
}

pub const STALE_GENERATION: &str = "SYNC_STALE_GENERATION";

fn generation(conn: &Connection) -> CommandResult<String> {
    if let Some(value) = get_value(conn, "generation")? {
        return Ok(value);
    }
    rotate_generation(conn)?;
    get_value(conn, "generation")?.ok_or_else(|| "Missing sync generation".into())
}

fn rotate_generation(conn: &Connection) -> CommandResult<()> {
    set_value(conn, "generation", uuid::Uuid::new_v4().to_string())
}

fn check_generation(conn: &Connection, expected: &str) -> CommandResult<()> {
    if generation(conn)? != expected {
        return Err(STALE_GENERATION.into());
    }
    Ok(())
}

pub(crate) fn push_outbox(conn: &Connection, doc: &str, bytes: &[u8]) -> CommandResult<()> {
    conn.execute(
        "insert into sync_outbox (doc, bytes) values (?1, ?2)",
        params![doc, bytes],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn is_enabled(conn: &Connection) -> CommandResult<bool> {
    conn.query_row("select 1 from sync_state where key = 'account'", [], |_| {
        Ok(())
    })
    .optional()
    .map(|row| row.is_some())
    .map_err(db_err)
}

pub fn record_update(conn: &Connection, module_id: &str, bytes: &[u8]) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    push_outbox(conn, module_id, bytes)?;
    Ok(true)
}

pub enum VaultChange<'a> {
    Name(&'a str),
    Recovered(&'a str),
    Deleted,
}

pub fn record_module(
    conn: &Connection,
    module_id: &str,
    change: VaultChange,
) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    section_moves::remember_synced_note(conn, module_id)?;
    let deleted = matches!(change, VaultChange::Deleted);
    let doc = load_vault(conn)?;
    let map = doc.get_or_insert_map(MODULES_MAP);
    let observed_moves = if deleted {
        let mut stmt = conn
            .prepare("select doc from sync_section_moves where destination=?1 order by doc")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([module_id], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        Some(
            serde_json::to_string(&rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?)
                .map_err(db_err)?,
        )
    } else {
        None
    };
    let deletions = deleted.then(|| doc.get_or_insert_map(MODULE_DELETIONS_MAP));
    let update = {
        let mut txn = doc.transact_mut();
        match change {
            VaultChange::Name(name) => {
                map.insert(&mut txn, format!("{module_id}.name"), name);
            }
            VaultChange::Recovered(name) => {
                map.insert(&mut txn, format!("{module_id}.name"), name);
                map.insert(&mut txn, format!("{module_id}.recovered"), true);
            }
            VaultChange::Deleted => {
                map.insert(&mut txn, format!("{module_id}.deleted"), true);
                if let (Some(deletions), Some(observed)) = (deletions, observed_moves) {
                    deletions.insert(
                        &mut txn,
                        format!("{module_id}/{}", uuid::Uuid::new_v4()),
                        observed,
                    );
                }
            }
        }
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    if deleted {
        forget_module_docs(conn, module_id)?;
        let modules = vault_modules(&doc);
        let mut stmt = conn.prepare(
            "select doc,source,destination from sync_section_moves where source=?1 or destination=?1",
        ).map_err(db_err)?;
        let moves = stmt
            .query_map([module_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?;
        for (id, source, destination) in moves {
            if [source, destination]
                .iter()
                .all(|module| modules.get(module).is_some_and(|note| note.deleted))
            {
                section_moves::retire(conn, &id)?;
            }
        }
    }
    Ok(true)
}

// A deleted note can still house the review log of a transferred card.
fn forget_module_docs(conn: &Connection, module_id: &str) -> CommandResult<()> {
    push_outbox(conn, module_id, &[])?;
    let retains_history: bool = conn
        .query_row(
            "select exists(select 1 from sync_card_locations where review_module=?1)",
            [module_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if !retains_history {
        let reviews = review_doc_id(module_id);
        conn.execute("delete from sync_docs where doc = ?1", [&reviews])
            .map_err(db_err)?;
        push_outbox(conn, &reviews, &[])?;
    }
    Ok(())
}

pub fn record_file(
    conn: &Connection,
    file_id: &str,
    module_id: &str,
    file_type: &str,
) -> CommandResult<bool> {
    if !is_enabled(conn)? || file_gone(conn, file_id)? {
        return Ok(false);
    }
    let doc = load_vault(conn)?;
    if string_entries(&doc, FILES_MAP)
        .iter()
        .any(|(id, record)| id == file_id && file_deleted(record))
    {
        return Ok(false);
    }
    conn.execute(
        "insert or ignore into sync_file_uploads (file_id) values (?1)",
        [file_id],
    )
    .map_err(db_err)?;
    let files = doc.get_or_insert_map(FILES_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        files.insert(&mut txn, file_id, file_record(module_id, file_type));
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    Ok(true)
}

// Keep the key so merging an older vault cannot reannounce a removed image.
pub fn record_file_deleted(conn: &Connection, file_id: &str) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    let doc = load_vault(conn)?;
    let files = doc.get_or_insert_map(FILES_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        files.insert(&mut txn, file_id, r#"{"deleted":true}"#);
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    queue_file_delete(conn, file_id)
}

// The caller records the image or document tombstone before queuing deletion.
pub(crate) fn queue_file_delete(conn: &Connection, file_id: &str) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    conn.execute(
        "insert or ignore into sync_file_deletes (file_id) values (?1)",
        [file_id],
    )
    .map_err(db_err)?;
    conn.execute(
        "delete from sync_file_uploads where file_id = ?1",
        [file_id],
    )
    .map_err(db_err)?;
    Ok(())
}

fn file_gone(conn: &Connection, file_id: &str) -> CommandResult<bool> {
    conn.query_row(
        "select exists(select 1 from sync_files_gone where file_id = ?1)",
        [file_id],
        |row| row.get(0),
    )
    .map_err(db_err)
}

pub(crate) fn deleted_file_ids(conn: &Connection) -> CommandResult<Vec<String>> {
    let mut stmt = conn
        .prepare("select file_id from sync_files_gone")
        .map_err(db_err)?;
    let mut ids = stmt
        .query_map([], |row| row.get(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(db_err)?;
    ids.extend(
        string_entries(&load_vault(conn)?, FILES_MAP)
            .into_iter()
            .filter_map(|(id, record)| file_deleted(&record).then_some(id)),
    );
    Ok(ids)
}

fn remember_file_gone(conn: &Connection, file_id: &str) -> CommandResult<()> {
    conn.execute(
        "insert or ignore into sync_files_gone (file_id) values (?1)",
        [file_id],
    )
    .map_err(db_err)?;
    let doc = load_vault(conn)?;
    let is_document = string_entries(&doc, DOCUMENTS_MAP)
        .iter()
        .any(|(id, _)| id == file_id)
        || conn
            .query_row(
                "select exists(select 1 from documents where id=?1)",
                [file_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(db_err)?;
    if is_document {
        record_document(conn, file_id, true)?;
        conn.execute("delete from sync_file_uploads where file_id=?1", [file_id])
            .map_err(db_err)?;
    } else {
        record_file_deleted(conn, file_id)?;
    }
    // The server already knows; only the vault needs the tombstone again.
    conn.execute(
        "delete from sync_file_deletes where file_id = ?1",
        [file_id],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn sync_file_gone(db: &Db, file_id: String, generation: String) -> CommandResult<()> {
    let mut conn = db.lock()?;
    check_generation(&conn, &generation)?;
    let tx = conn.transaction().map_err(db_err)?;
    remember_file_gone(&tx, &file_id)?;
    tx.commit().map_err(db_err)
}

pub(crate) fn retain_deleted_files(conn: &Connection, ids: &[String]) -> CommandResult<()> {
    for id in ids {
        conn.execute(
            "insert or ignore into sync_files_gone (file_id) values (?1)",
            [id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

const DOCUMENTS_MAP: &str = "documents";

#[derive(serde::Serialize, serde::Deserialize)]
struct DocumentMetadata {
    module: String,
    name: String,
    size: i64,
    // Preserve newest-first ordering on every device, including after reseeding.
    #[serde(default, rename = "createdAt")]
    created_at: i64,
}

fn document_entries(conn: &Connection) -> CommandResult<Vec<(String, String)>> {
    conn.prepare("select id,module_id,name,size,created_at from documents")
        .map_err(db_err)?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                DocumentMetadata {
                    module: r.get(1)?,
                    name: r.get(2)?,
                    size: r.get(3)?,
                    created_at: r.get(4)?,
                },
            ))
        })
        .map_err(db_err)?
        .map(|row| {
            let (id, record) = row.map_err(db_err)?;
            Ok((id, serde_json::to_string(&record).map_err(db_err)?))
        })
        .collect()
}

pub(crate) fn record_document(conn: &Connection, id: &str, deleted: bool) -> CommandResult<()> {
    if deleted {
        crate::pdf_annotations::publish_deleted(conn, id)?;
    }
    if !is_enabled(conn)? || (!deleted && file_gone(conn, id)?) {
        return Ok(());
    }
    let record = if deleted {
        "{\"deleted\":true}".to_owned()
    } else {
        document_entries(conn)?
            .into_iter()
            .find(|(key, _)| key == id)
            .ok_or("Document not found")?
            .1
    };
    let doc = load_vault(conn)?;
    let map = doc.get_or_insert_map(DOCUMENTS_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, id, record);
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)
}

fn deleted_documents(doc: &Doc) -> HashSet<String> {
    string_entries(doc, DOCUMENTS_MAP)
        .into_iter()
        .filter_map(|(id, record)| {
            let record: serde_json::Value = serde_json::from_str(&record).ok()?;
            (record["deleted"] == true && uuid::Uuid::parse_str(&id).is_ok()).then_some(id)
        })
        .collect()
}

pub(crate) fn deleted_annotation_documents(
    conn: &Connection,
    doc: &Doc,
) -> CommandResult<Vec<String>> {
    let mut ids: Vec<_> = deleted_documents(doc).into_iter().collect();
    let modules = vault_modules(doc);
    for (id, record) in string_entries(doc, DOCUMENTS_MAP) {
        if serde_json::from_str::<DocumentMetadata>(&record)
            .is_ok_and(|r| modules.get(&r.module).is_some_and(|m| m.deleted))
        {
            ids.push(id);
        }
    }
    let mut stmt = conn
        .prepare("select id,module_id from documents")
        .map_err(db_err)?;
    for row in stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(db_err)?
    {
        let (id, module) = row.map_err(db_err)?;
        if file_gone(conn, &id)? || modules.get(&module).is_some_and(|m| m.deleted) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn reconcile_documents(conn: &Connection, doc: &Doc) -> CommandResult<()> {
    let modules = vault_modules(doc);
    for (id, record) in string_entries(doc, DOCUMENTS_MAP) {
        if uuid::Uuid::parse_str(&id).is_err() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<DocumentMetadata>(&record) else {
            continue;
        };
        if record.size < 0
            || file_gone(conn, &id)?
            || modules.get(&record.module).is_some_and(|m| m.deleted)
            || !module_exists(conn, &record.module)?
        {
            continue;
        }
        conn.execute(
            "insert into documents(id,module_id,name,size,created_at) values (?1,?2,?3,?4,?5)
            on conflict(id) do update set name=excluded.name,size=excluded.size",
            params![
                id,
                record.module,
                record.name,
                record.size,
                record.created_at
            ],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

fn file_deleted(record: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(record).is_ok_and(|record| record["deleted"] == true)
}

// Publishes images whose owning note changed since the vault last named it,
// e.g. when the owner was deleted and a surviving note took the image over.
// Only images the vault already knows are touched.
pub fn publish_file_owners(conn: &Connection) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    let doc = load_vault(conn)?;
    let known: BTreeMap<String, String> = string_entries(&doc, FILES_MAP).into_iter().collect();
    let local: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare("select id, module_id, file_type from files where id not in (select file_id from sync_files_gone)")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    let changed: Vec<(String, String)> = local
        .into_iter()
        .filter_map(|(id, module_id, file_type)| {
            let record = file_record(&module_id, &file_type);
            known
                .get(&id)
                .is_some_and(|current| !file_deleted(current) && *current != record)
                .then_some((id, record))
        })
        .collect();
    if changed.is_empty() {
        return Ok(false);
    }
    let files = doc.get_or_insert_map(FILES_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        for (id, record) in &changed {
            files.insert(&mut txn, id.as_str(), record.as_str());
        }
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    Ok(true)
}

fn file_record(module_id: &str, file_type: &str) -> String {
    serde_json::json!({ "module": module_id, "type": file_type }).to_string()
}

// Records a card's state after a review or an undo, with the log row that was
// added or the sync id of the one that was removed.
pub fn record_review(
    conn: &Connection,
    card_id: &str,
    added_log: Option<i64>,
    removed_log: Option<&str>,
) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    let (module_id, state): (String, String) = conn
        .query_row(
            &format!(
                "select module_id, {} from cards where id = ?1",
                card_state_json()
            ),
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;
    let added = match added_log {
        Some(rowid) => Some(
            conn.query_row(
                &format!(
                    "select sync_id, {} from review_log where id = ?1",
                    log_json()
                ),
                [rowid],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(db_err)?,
        ),
        None => None,
    };
    let route = section_moves::review_route(conn, card_id)?;
    let (home, state_key, carried) = match route {
        Some(route) => {
            let epoch = route.epochs.last().ok_or("Missing review epoch")?;
            (route.review_module, format!("{epoch}/{card_id}"), true)
        }
        None => (module_id, card_id.to_owned(), false),
    };
    let doc_id = review_doc_id(&home);
    let doc = load_doc(conn, &doc_id)?;
    let cards = doc.get_or_insert_map(REVIEW_CARDS_MAP);
    let log = doc.get_or_insert_map(REVIEW_LOG_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        cards.insert(&mut txn, state_key, state);
        if let Some((sync_id, row)) = added {
            log.insert(&mut txn, sync_id, row);
        }
        if let Some(sync_id) = removed_log {
            log.insert(&mut txn, sync_id, "");
        }
        txn.encode_update_v1()
    };
    save_doc(conn, &doc_id, &doc)?;
    if carried {
        carry_reviews(conn, &home)?;
    } else {
        push_outbox(conn, &doc_id, &update)?;
        let transferred: bool = conn
            .query_row(
                "select exists(select 1 from sync_card_locations where review_module=?1)",
                [&home],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if transferred {
            carry_reviews(conn, &home)?;
        }
    }
    Ok(true)
}

fn load_doc(conn: &Connection, doc_id: &str) -> CommandResult<Doc> {
    let doc = Doc::new();
    let state: Option<Vec<u8>> = conn
        .query_row(
            "select state from sync_docs where doc = ?1",
            [doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if let Some(state) = state {
        let update = Update::decode_v1(&state).map_err(db_err)?;
        doc.transact_mut().apply_update(update).map_err(db_err)?;
    }
    Ok(doc)
}

fn save_doc(conn: &Connection, doc_id: &str, doc: &Doc) -> CommandResult<()> {
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    conn.execute(
        "insert into sync_docs (doc, state) values (?1, ?2)
         on conflict(doc) do update set state = excluded.state",
        params![doc_id, state],
    )
    .map(|_| ())
    .map_err(db_err)
}

fn string_entries(doc: &Doc, map_name: &str) -> Vec<(String, String)> {
    let map = doc.get_or_insert_map(map_name);
    let txn = doc.transact();
    map.iter(&txn)
        .filter_map(|(key, value)| match value {
            Out::Any(Any::String(text)) => Some((key.to_string(), text.to_string())),
            _ => {
                eprintln!(
                    "Invalid sync map value {map_name}/{key} (1 skipped row): expected string"
                );
                None
            }
        })
        .collect()
}

// Materialize schedules from the current owner epoch first. Until it has
// a review or undo, an offline review from the previous owner can still supply
// the schedule. Every epoch shares the log and its undo tombstones.
fn apply_review_doc(conn: &Connection, module_id: &str, doc: &Doc) -> CommandResult<bool> {
    let states: BTreeMap<_, _> = string_entries(doc, REVIEW_CARDS_MAP).into_iter().collect();
    let mut locations = conn
        .prepare(
            "select location.card_id, location.epochs from sync_card_locations location
         join cards on cards.id=location.card_id and cards.module_id=location.module_id
         where location.review_module=?1",
        )
        .map_err(db_err)?;
    let moved = locations
        .query_map([module_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_err)?;
    let mut changed = false;
    let values = crate::cards::CARD_STATE_FIELDS
        .iter()
        .map(|field| format!("json_extract(?2, '$.{field}')"))
        .collect::<Vec<_>>()
        .join(", ");
    let fields = crate::cards::CARD_STATE_FIELDS.join(", ");
    let mut regular = conn.prepare(&format!(
        "update cards set ({fields})=({values})
         where id=?1 and module_id=?3 and not exists(select 1 from sync_card_locations where card_id=?1)
           and ({fields}) is not ({values})"
    )).map_err(db_err)?;
    for (card_id, state) in &states {
        changed |= regular
            .execute(params![card_id, state, module_id])
            .map_err(db_err)?
            > 0;
    }
    let mut transferred = conn
        .prepare(&format!(
            "update cards set ({fields})=({values}) where id=?1
         and ({fields}) is not ({values})"
        ))
        .map_err(db_err)?;
    for location in moved {
        let (card_id, epochs) = location.map_err(db_err)?;
        let epochs: Vec<String> = serde_json::from_str(&epochs).map_err(db_err)?;
        let state = epochs
            .iter()
            .rev()
            .find_map(|epoch| states.get(&format!("{epoch}/{card_id}")))
            .or_else(|| states.get(&card_id));
        if let Some(state) = state {
            changed |= transferred
                .execute(params![card_id, state])
                .map_err(db_err)?
                > 0;
        }
    }
    for (sync_id, row) in string_entries(doc, REVIEW_LOG_MAP) {
        if row.is_empty() {
            changed |= conn.execute(
                "delete from review_log where sync_id=?1 and exists(
                    select 1 from cards left join sync_card_locations location on location.card_id=cards.id
                    where cards.id=review_log.card_id and coalesce(location.review_module, cards.module_id)=?2
                      and cards.module_id=coalesce(location.module_id, cards.module_id)
                )",
                params![sync_id, module_id],
            ).map_err(db_err)? > 0;
            continue;
        }
        changed |= conn.execute(
            "insert or ignore into review_log (sync_id, card_id, rating, review_time, duration_ms,
                 fsrs_model, state, schedule_status, due_at, last_review_at, stability,
                 stability_fast, difficulty, scheduled_days, learning_step)
             select ?1, json_extract(?2, '$.card_id'), json_extract(?2, '$.rating'),
                 json_extract(?2, '$.review_time'), json_extract(?2, '$.duration_ms'),
                 json_extract(?2, '$.fsrs_model'), json_extract(?2, '$.state'),
                 json_extract(?2, '$.schedule_status'), json_extract(?2, '$.due_at'),
                 json_extract(?2, '$.last_review_at'), json_extract(?2, '$.stability'),
                 json_extract(?2, '$.stability_fast'), json_extract(?2, '$.difficulty'),
                 json_extract(?2, '$.scheduled_days'), json_extract(?2, '$.learning_step')
             where exists (select 1 from cards left join sync_card_locations location on location.card_id=cards.id
                 where cards.id=json_extract(?2, '$.card_id')
                   and coalesce(location.review_module, cards.module_id)=?3
                   and cards.module_id=coalesce(location.module_id, cards.module_id))",
            params![sync_id, row, module_id],
        )
        .map_err(db_err)? > 0;
    }
    Ok(changed)
}

// After a note's cards were (re)indexed, gives new card rows their synced
// review state.
pub fn apply_reviews(conn: &Connection, module_id: &str) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("select ?1 union select review_module from sync_card_locations where module_id=?1")
        .map_err(db_err)?;
    let modules = stmt
        .query_map([module_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    for module in modules {
        let module = module.map_err(db_err)?;
        let doc_id = review_doc_id(&module);
        let exists: bool = conn
            .query_row(
                "select exists(select 1 from sync_docs where doc=?1)",
                [&doc_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if exists {
            apply_review_doc(conn, &module, &load_doc(conn, &doc_id)?)?;
        }
    }
    Ok(())
}

fn get_value<T: rusqlite::types::FromSql>(
    conn: &Connection,
    key: &str,
) -> CommandResult<Option<T>> {
    conn.query_row(
        "select value from sync_state where key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_err)
}

fn set_value(conn: &Connection, key: &str, value: impl rusqlite::ToSql) -> CommandResult<()> {
    conn.execute(
        "insert into sync_state (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(db_err)
}

fn cursor(conn: &Connection) -> CommandResult<i64> {
    Ok(get_value::<i64>(conn, "cursor")?.unwrap_or(0))
}

pub(crate) fn record_sidebar(
    conn: &Connection,
    items: &[crate::sidebar::SidebarItem],
) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    let doc = load_vault(conn)?;
    let map = doc.get_or_insert_map("sidebar");
    let update = {
        let mut txn = doc.transact_mut();
        for item in items {
            map.insert(
                &mut txn,
                item.id.as_str(),
                serde_json::to_string(item).map_err(db_err)?,
            );
        }
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    Ok(())
}

pub(crate) fn load_vault(conn: &Connection) -> CommandResult<Doc> {
    let doc = Doc::new();
    if let Some(state) = get_value::<Vec<u8>>(conn, "vault")? {
        let update = Update::decode_v1(&state).map_err(db_err)?;
        doc.transact_mut().apply_update(update).map_err(db_err)?;
    }
    Ok(doc)
}

pub(crate) fn save_vault(conn: &Connection, doc: &Doc) -> CommandResult<()> {
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    set_value(conn, "vault", state)
}

#[derive(Debug, Default, PartialEq)]
struct VaultModule {
    name: Option<String>,
    deleted: bool,
    recovered: bool,
}

fn vault_modules(doc: &Doc) -> BTreeMap<String, VaultModule> {
    let map = doc.get_or_insert_map(MODULES_MAP);
    let txn = doc.transact();
    let mut modules: BTreeMap<String, VaultModule> = BTreeMap::new();
    for (key, value) in map.iter(&txn) {
        let Some((id, field)) = key.rsplit_once('.') else {
            continue;
        };
        let module = modules.entry(id.to_string()).or_default();
        match (field, value) {
            ("name", Out::Any(Any::String(name))) => module.name = Some(name.to_string()),
            ("deleted", Out::Any(Any::Bool(true))) => module.deleted = true,
            ("recovered", Out::Any(Any::Bool(true))) => module.recovered = true,
            _ => {}
        }
    }
    modules
}

fn module_exists(conn: &Connection, module_id: &str) -> CommandResult<bool> {
    conn.query_row("select 1 from modules where id = ?1", [module_id], |_| {
        Ok(())
    })
    .optional()
    .map(|row| row.is_some())
    .map_err(db_err)
}

// Brings the local module rows in line with the vault: creates and renames.
// Returns the modules the vault deleted that still exist here; deleting them
// removes files, so the caller does it after committing.
fn reconcile(tx: &Transaction, doc: &Doc) -> CommandResult<(bool, Vec<String>)> {
    let mut changed = false;
    let mut deleted = Vec::new();
    for (id, module) in vault_modules(doc) {
        let local: Option<String> = tx
            .query_row("select name from modules where id = ?1", [&id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_err)?;
        if module.deleted {
            if local.is_some() {
                deleted.push(id);
            }
            continue;
        }
        if module.recovered {
            tx.execute(
                "insert or ignore into section_conflict_notes(module_id) values (?1)",
                [&id],
            )
            .map_err(db_err)?;
        }
        let Some(name) = module.name else { continue };
        section_moves::remember_synced_note(tx, &id)?;
        match local {
            None => {
                crate::content::module_rows::insert(tx, &id, &name, &[])?;
                changed = true;
            }
            Some(current) if current != name => {
                crate::content::module_rows::rename(tx, &id, &name)?;
                changed = true;
            }
            Some(_) => {}
        }
    }
    {
        let map = doc.get_or_insert_map("sidebar");
        let txn = doc.transact();
        for (id, value) in map.iter(&txn) {
            if let Out::Any(Any::String(json)) = value {
                let item: crate::sidebar::SidebarItem =
                    serde_json::from_str(&json).map_err(db_err)?;
                if item.id != id {
                    return Err("Invalid sidebar entry".into());
                }
                changed |= crate::sidebar::store(tx, &item)?;
            }
        }
    }
    reconcile_documents(tx, doc)?;
    Ok((changed, deleted))
}

// Queues everything stored locally: the vault (with every module added) and
// each note's snapshot and saved updates.
fn seed(conn: &Connection) -> CommandResult<()> {
    let has_transfers: bool = conn
        .query_row("select exists(select 1 from sync_section_moves)", [], |r| {
            r.get(0)
        })
        .map_err(db_err)?;
    if has_transfers && !section_moves::published_transfers_supported() {
        return Err("These notes contain cross-note moves that require compatible sync.".into());
    }
    conn.execute(
        "insert or ignore into section_synced_notes(module_id) select id from modules",
        [],
    )
    .map_err(db_err)?;
    conn.execute("delete from sync_outbox", [])
        .map_err(db_err)?;
    let doc = load_vault(conn)?;
    let map = doc.get_or_insert_map(MODULES_MAP);
    let modules: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("select id, name from modules")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    {
        let known = vault_modules(&doc);
        let mut txn = doc.transact_mut();
        for (id, name) in &modules {
            let recorded = known.get(id).and_then(|module| module.name.as_deref());
            if recorded != Some(name.as_str()) {
                map.insert(&mut txn, format!("{id}.name"), name.as_str());
            }
        }
    }
    {
        let sidebar = doc.get_or_insert_map("sidebar");
        let mut txn = doc.transact_mut();
        for item in crate::sidebar::read(conn)? {
            sidebar.insert(
                &mut txn,
                item.id.as_str(),
                serde_json::to_string(&item).map_err(db_err)?,
            );
        }
    }
    let files: Vec<(String, String, String)> = {
        // PDFs are announced through the documents map only; see record_document.
        let mut stmt = conn
            .prepare("select id, module_id, file_type from files where id not in (select id from documents) and id not in (select file_id from sync_files_gone)")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    {
        let files_map = doc.get_or_insert_map(FILES_MAP);
        let known: BTreeMap<_, _> = string_entries(&doc, FILES_MAP).into_iter().collect();
        let mut txn = doc.transact_mut();
        for (id, module_id, file_type) in &files {
            if known.get(id).is_some_and(|record| file_deleted(record)) {
                continue;
            }
            files_map.insert(&mut txn, id.as_str(), file_record(module_id, file_type));
        }
    }
    {
        let map = doc.get_or_insert_map(DOCUMENTS_MAP);
        let mut txn = doc.transact_mut();
        for (id, record) in document_entries(conn)? {
            if file_gone(conn, &id)? {
                continue;
            }
            map.insert(&mut txn, id, record);
        }
    }
    conn.execute_batch("delete from sync_file_uploads; insert into sync_file_uploads (file_id) select id from files where id not in (select file_id from sync_files_gone);")
        .map_err(db_err)?;
    crate::pdf_annotations::seed(conn, &doc)?;
    save_vault(conn, &doc)?;
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    push_outbox(conn, VAULT_DOC, &state)?;
    conn.execute(
        "insert into sync_outbox (doc, bytes) select doc, state from sync_section_moves order by rowid",
        [],
    ).map_err(db_err)?;
    conn.execute(
        "insert into sync_outbox (doc, bytes)
         select module_id, state from contents where length(state) > 0",
        [],
    )
    .map_err(db_err)?;
    conn.execute(
        "insert into sync_outbox (doc, bytes)
         select module_id, bytes from contents_updates order by id",
        [],
    )
    .map_err(db_err)?;
    seed_reviews(conn)
}

fn seed_reviews(conn: &Connection) -> CommandResult<()> {
    conn.execute(
        "delete from sync_docs where doc like ?1",
        [format!("{REVIEW_PREFIX}%")],
    )
    .map_err(db_err)?;
    conn.execute_batch(
        "update review_log set sync_id = lower(hex(randomblob(16))) where sync_id is null;",
    )
    .map_err(db_err)?;
    let mut stmt = conn
        .prepare(
            "select distinct coalesce(location.review_module, cards.module_id)
         from cards left join sync_card_locations location on location.card_id=cards.id",
        )
        .map_err(db_err)?;
    let modules = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    for module_id in modules {
        let module_id = module_id.map_err(db_err)?;
        let states: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "select coalesce(json_extract(location.epochs, '$[#-1]') || '/', '') || cards.id, {}
                     from cards left join sync_card_locations location on location.card_id=cards.id
                     where coalesce(location.review_module, cards.module_id)=?1
                       and (reps > 0 or last_review_at is not null or location.card_id is not null)",
                    card_state_json()
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map([&module_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        let logs: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "select sync_id, {} from review_log
                     where card_id in (
                         select cards.id from cards left join sync_card_locations location on location.card_id=cards.id
                         where coalesce(location.review_module, cards.module_id)=?1
                     ) order by id",
                    log_json()
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map([&module_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        if states.is_empty() && logs.is_empty() {
            continue;
        }
        let doc_id = review_doc_id(&module_id);
        let doc = Doc::new();
        let cards = doc.get_or_insert_map(REVIEW_CARDS_MAP);
        let log = doc.get_or_insert_map(REVIEW_LOG_MAP);
        {
            let mut txn = doc.transact_mut();
            for (card_id, state) in states {
                cards.insert(&mut txn, card_id, state);
            }
            for (sync_id, row) in logs {
                log.insert(&mut txn, sync_id, row);
            }
        }
        save_doc(conn, &doc_id, &doc)?;
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let carried: bool = conn
            .query_row(
                "select exists(select 1 from sync_card_locations where review_module=?1)",
                [&module_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        let upload_id = if carried {
            carried_reviews_id(&module_id)
        } else {
            doc_id
        };
        push_outbox(conn, &upload_id, &state)?;
    }
    Ok(())
}

fn delete_modules(conn: &mut Connection, files_dir: &Path, ids: &[String]) -> CommandResult<()> {
    let data_dir = files_dir.parent().ok_or("Invalid files directory")?;
    for id in deleted_documents(&load_vault(conn)?) {
        crate::documents::remove_local(data_dir, conn, &id)?;
    }
    // Keep received review docs. A move arriving after this tombstone may
    // still need the old note's review doc for the cards it moved out.
    for id in ids {
        crate::content::delete_remote_module_data(conn, files_dir, id)?;
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    generation: String,
    pub(crate) account: Option<String>,
    cursor: i64,
    pending: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct OutboxEntry {
    id: i64,
    doc: String,
    bytes: Vec<u8>,
}

#[derive(Debug, serde::Deserialize)]
pub struct RemoteEntry {
    // Sent by the frontend; the cursor is passed separately.
    seq: i64,
    doc: String,
    bytes: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdate {
    module_id: String,
    update: ContentUpdate,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    updates: Vec<RemoteUpdate>,
    modules_changed: bool,
    pub deleted: Vec<String>,
    reviews_changed: bool,
    files_changed: bool,
    pub annotations_changed: Vec<String>,
}

pub(crate) fn status(conn: &Connection) -> CommandResult<SyncStatus> {
    Ok(SyncStatus {
        generation: generation(conn)?,
        account: get_value(conn, "account")?,
        cursor: cursor(conn)?,
        pending: conn
            .query_row("select count(*) from sync_outbox", [], |row| row.get(0))
            .map_err(db_err)?,
    })
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AccountIdentity {
    server: String,
    #[serde(rename = "userId")]
    user_id: String,
}
fn account_identity(raw: &str) -> String {
    match serde_json::from_str::<AccountIdentity>(raw) {
        Ok(mut identity) => {
            identity.server = identity.server.trim_end_matches('/').to_owned();
            serde_json::to_string(&identity).unwrap()
        }
        Err(_) => raw.to_owned(), // pre-identity native rows migrate at host startup
    }
}

fn enable(conn: &mut Connection, account: &str) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let was_enabled = is_enabled(&tx)?;
    set_value(&tx, "account", account_identity(account))?;
    rotate_generation(&tx)?;
    if !was_enabled {
        set_value(&tx, "cursor", 0)?;
        seed(&tx)?;
    }
    tx.commit().map_err(db_err)
}

/// A snapshot owns notes, but must not change the device's signed-in account.
/// Both hosts persist only the server and user ID.
pub(crate) fn reconcile_restored_account(
    conn: &mut Connection,
    current: Option<&str>,
) -> CommandResult<()> {
    let restored = get_value::<String>(conn, "account")?;
    let same = restored.as_deref().map(account_identity) == current.map(account_identity)
        && current.is_some();
    let tx = conn.transaction().map_err(db_err)?;
    if !same {
        disable(&tx)?;
    }
    if let Some(account) = current {
        set_value(&tx, "account", account_identity(account))?;
        if !same {
            set_value(&tx, "cursor", 0)?;
            seed(&tx)?;
        }
    }
    if same {
        let doc = load_vault(&tx)?;
        crate::pdf_annotations::seed(&tx, &doc)?;
        save_vault(&tx, &doc)?;
        let has_history: bool = tx.query_row("select exists(select 1 from pdf_annotations) or exists(select 1 from pdf_annotation_tombstones)", [], |r| r.get(0)).map_err(db_err)?;
        if has_history {
            push_outbox(
                &tx,
                VAULT_DOC,
                &doc.transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )?;
        }
    }
    rotate_generation(&tx)?;
    tx.commit().map_err(db_err)
}

fn disable(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "delete from sync_outbox; delete from sync_state; delete from sync_docs;
         delete from pending_section_moves; delete from sync_file_uploads; delete from sync_file_deletes;",
    )
    .map_err(db_err)?;
    rotate_generation(conn)
}

fn outbox(conn: &Connection, limit_bytes: i64) -> CommandResult<Vec<OutboxEntry>> {
    // Oldest first, stopping once the running total passes the limit, but
    // always at least one entry.
    let mut stmt = conn
        .prepare(
            "select id, doc, bytes from (
                 select id, doc, bytes, sum(length(bytes)) over (order by id) as total
                 from sync_outbox
             ) where total - length(bytes) < ?1 order by id limit 2000",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([limit_bytes], |row| {
            Ok(OutboxEntry {
                id: row.get(0)?,
                doc: row.get(1)?,
                bytes: row.get(2)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

#[derive(Default)]
struct NotePull {
    touched: HashSet<String>,
    worksheet_history: BTreeMap<String, crate::worksheets::Bank>,
}

impl NotePull {
    fn apply(
        &mut self,
        tx: &Transaction<'_>,
        result: &mut ApplyResult,
        module: String,
        bytes: Vec<u8>,
    ) -> CommandResult<()> {
        section_moves::remember_synced_note(tx, &module)?;
        if !module_exists(tx, &module)? {
            // A compacted vault may name the note in a later frame.
            crate::content::module_rows::insert(tx, &module, "Untitled", &[])?;
            result.modules_changed = true;
        }
        if self.touched.insert(module.clone()) {
            if let Ok(before) = crate::worksheets::load(tx, &module) {
                if let Ok(Some(bank)) = crate::worksheets::read(&before) {
                    self.worksheet_history.insert(module.clone(), bank);
                }
            }
        }
        tx.execute(
            "insert into contents_updates (module_id, bytes, created_at) values (?1, ?2, ?3)",
            params![module, bytes, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(db_err)?;
        result.updates.push(RemoteUpdate {
            module_id: module,
            update: ContentUpdate {
                id: tx.last_insert_rowid(),
                bytes,
            },
        });
        Ok(())
    }
}

fn apply_remote(
    conn: &mut Connection,
    files_dir: &Path,
    entries: Vec<RemoteEntry>,
    new_cursor: i64,
) -> CommandResult<ApplyResult> {
    let tx = conn.transaction().map_err(db_err)?;
    if !is_enabled(&tx)? {
        return Err("Sync is off".into());
    }
    let mut result = ApplyResult::default();
    for entry in &entries {
        if entry.seq > new_cursor {
            eprintln!(
                "Sync entry {} sequence {} exceeds batch cursor {new_cursor}",
                entry.doc, entry.seq
            );
        }
    }

    // The vault first, so modules exist before their content is stored.
    let (vault_entries, rest): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|entry| entry.doc == VAULT_DOC);
    let (review_entries, note_entries): (Vec<_>, Vec<_>) = rest.into_iter().partition(|entry| {
        entry.doc.starts_with(REVIEW_PREFIX) && !entry.doc.starts_with(section_moves::SYNC_PREFIX)
    });
    let doc = load_vault(&tx)?;
    if !vault_entries.is_empty() {
        {
            let mut txn = doc.transact_mut();
            for entry in &vault_entries {
                let update = Update::decode_v1(&entry.bytes).map_err(db_err)?;
                txn.apply_update(update).map_err(db_err)?;
            }
        }
        crate::pdf_annotations::admit_incoming(&load_vault(&tx)?, &doc)?;
        // Remote file tombstones leave local bytes intact: note/card references
        // and undo leases remain authoritative. Normal cleanup reclaims them.
        save_vault(&tx, &doc)?;
    }
    let (changed, deleted) = reconcile(&tx, &doc)?;
    result.annotations_changed = crate::pdf_annotations::reconcile(&tx, &doc)?;
    result.modules_changed = changed;
    result.deleted = deleted;
    let vault = vault_modules(&doc);

    let is_deleted = |module: &str| vault.get(module).is_some_and(|note| note.deleted);
    let deletions = if vault.values().any(|note| note.deleted) {
        let mut deletions = BTreeMap::<String, Vec<Vec<String>>>::new();
        for (key, observed) in string_entries(&doc, MODULE_DELETIONS_MAP) {
            if let Some((module, _)) = key.split_once('/') {
                deletions
                    .entry(module.to_owned())
                    .or_default()
                    .push(serde_json::from_str(&observed).map_err(db_err)?);
            }
        }
        deletions
    } else {
        BTreeMap::new()
    };
    let mut content_entries = Vec::new();
    for entry in note_entries {
        if entry.doc.starts_with(section_moves::SYNC_PREFIX) {
            section_moves::stage(&tx, &entry.doc, &entry.bytes)?;
        } else {
            content_entries.push((entry.doc, entry.bytes));
        }
    }
    let mut notes = NotePull::default();
    let mut transfer_reviews = HashSet::new();
    let mut moved_sections = false;
    // Try the transfer before dependent note edits, then again after any
    // newly arrived prerequisites. No partial move is visible between pulls.
    loop {
        let mut applied = false;
        let pending = {
            let mut stmt = tx
                .prepare("select doc,state from pending_section_moves order by rowid")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        for (id, bytes) in pending {
            if let Some(movement) = section_moves::receive(&tx, &id, &bytes, is_deleted)? {
                transfer_reviews.extend(movement.review_modules);
                if let Some(conflict) = movement.conflict {
                    let source = &movement.edits[0].0;
                    let module = conflict.module_id;
                    if !is_deleted(&module) && !module_exists(&tx, &module)? {
                        let name: String = tx
                            .query_row("select name from modules where id=?1", [source], |r| {
                                r.get(0)
                            })
                            .map_err(db_err)?;
                        let title = format!("Recovered chapter from {name}");
                        crate::content::module_rows::insert(&tx, &module, &title, &[])?;
                        tx.execute(
                            "insert into section_conflict_notes(module_id) values (?1)",
                            [&module],
                        )
                        .map_err(db_err)?;
                        record_module(&tx, &module, VaultChange::Recovered(&title))?;
                        record_update(&tx, &module, &conflict.content)?;
                        notes.apply(&tx, &mut result, module, conflict.content)?;
                        result.modules_changed = true;
                    }
                    // Top-level blocks inserted offline are independent of
                    // the author's cut. Keep them in the recovery note.
                    if let Some(cut) = conflict.source_cut {
                        record_update(&tx, source, &cut)?;
                        notes.apply(&tx, &mut result, source.clone(), cut)?;
                    }
                }
                for (doc, bytes) in movement.edits {
                    if !is_deleted(&doc) {
                        notes.apply(&tx, &mut result, doc, bytes)?;
                    }
                }
                moved_sections = true;
                applied = true;
            }
        }
        for (doc, bytes) in content_entries.drain(..) {
            if !is_deleted(&doc) {
                notes.apply(&tx, &mut result, doc, bytes)?;
                applied = true;
            }
        }
        if !applied {
            break;
        }
    }

    let recoveries =
        {
            let mut stmt = tx.prepare(
            "select m.doc,m.source,m.destination from sync_section_moves m order by m.rowid",
        ).map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
    for (id, source, destination) in recoveries {
        if is_deleted(&destination) && is_deleted(&source) {
            section_moves::retire(&tx, &id)?;
        } else if is_deleted(&destination)
            && deletions
                .get(&destination)
                .is_none_or(|events| events.iter().any(|observed| !observed.contains(&id)))
        {
            if let Some((doc, bytes)) = section_moves::recover(&tx, &id)? {
                notes.apply(&tx, &mut result, doc, bytes)?;
                moved_sections = true;
            }
        }
    }
    if moved_sections {
        section_moves::relocate_cards(&tx)?;
        result.reviews_changed = true;
    }
    for (module, old) in notes.worksheet_history {
        let after = crate::worksheets::load(&tx, &module)?;
        match crate::worksheets::read(&after) {
            Ok(Some(new)) => crate::worksheets::preserve_history(&old, &new)?,
            Ok(None) => return Err("Worksheet history cannot be removed".into()),
            Err(_) => {} // Future roots/fields remain opaque and quarantined.
        }
    }
    let mut reviews: BTreeMap<String, Vec<RemoteEntry>> = BTreeMap::new();
    for entry in review_entries {
        let home = entry
            .doc
            .strip_prefix(CARRIED_REVIEWS_PREFIX)
            .map(review_doc_id)
            .unwrap_or_else(|| entry.doc.clone());
        reviews.entry(home).or_default().push(entry);
    }
    for module in transfer_reviews {
        reviews.entry(review_doc_id(&module)).or_default();
    }
    for (doc_id, entries) in reviews {
        let module_id = &doc_id[REVIEW_PREFIX.len()..];
        let doc = load_doc(&tx, &doc_id)?;
        {
            let mut txn = doc.transact_mut();
            for entry in &entries {
                txn.apply_update(Update::decode_v1(&entry.bytes).map_err(db_err)?)
                    .map_err(db_err)?;
            }
        }
        if !entries.is_empty() {
            save_doc(&tx, &doc_id, &doc)?;
        }
        result.reviews_changed |= apply_review_doc(&tx, module_id, &doc)?;
    }
    result.files_changed = !vault_entries.is_empty() && !missing_files(&tx)?.is_empty();

    for module_id in &notes.touched {
        crate::asset_refs::publish_current(&tx, module_id)?;
        crate::search::invalidate_indexes(&tx, module_id)?;
    }
    let previous = cursor(&tx)?;
    set_value(&tx, "cursor", previous.max(new_cursor))?;
    tx.commit().map_err(db_err)?;

    delete_modules(conn, files_dir, &result.deleted)?;
    Ok(result)
}

fn snapshot(conn: &Connection, doc_id: &str) -> CommandResult<Option<Vec<u8>>> {
    if doc_id == VAULT_DOC {
        let doc = load_vault(conn)?;
        return Ok(Some(
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        ));
    }
    if doc_id.starts_with(section_moves::SYNC_PREFIX) {
        // The move is immutable. Replacing it with a later snapshot would
        // let compaction reorder it behind the notes that depend on it.
        return Ok(Some(Vec::new()));
    }
    if doc_id.starts_with(REVIEW_PREFIX) {
        let home = doc_id
            .strip_prefix(CARRIED_REVIEWS_PREFIX)
            .map(review_doc_id);
        return conn
            .query_row(
                "select state from sync_docs where doc = ?1",
                [home.as_deref().unwrap_or(doc_id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err);
    }
    let move_pending: bool = conn
        .query_row(
            "select exists(select 1 from sync_outbox o join sync_section_moves m on m.doc=o.doc
         where m.source=?1 or m.destination=?1)",
            [doc_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if move_pending {
        // An ordinary note snapshot would expose half of this unpublished
        // transaction to a receiver. Retry on a later compaction hint.
        return Ok(Some(Vec::new()));
    }
    let Some(state) = conn
        .query_row(
            "select state from contents where module_id = ?1",
            [doc_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(db_err)?
    else {
        return Ok(None);
    };
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        if !state.is_empty() {
            txn.apply_update(Update::decode_v1(&state).map_err(db_err)?)
                .map_err(db_err)?;
        }
        let mut stmt = conn
            .prepare("select bytes from contents_updates where module_id = ?1 order by id")
            .map_err(db_err)?;
        let updates = stmt
            .query_map([doc_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(db_err)?;
        for bytes in updates {
            let bytes = bytes.map_err(db_err)?;
            txn.apply_update(Update::decode_v1(&bytes).map_err(db_err)?)
                .map_err(db_err)?;
        }
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(Some(state))
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFile {
    file_id: String,
    module_id: String,
    file_type: String,
}

// Images other devices added that this one has not downloaded, for modules
// that exist here.
fn missing_files(conn: &Connection) -> CommandResult<Vec<MissingFile>> {
    let doc = load_vault(conn)?;
    let mut missing = Vec::new();
    let deleted_documents = deleted_documents(&doc);
    for (file_id, record) in string_entries(&doc, FILES_MAP) {
        if file_gone(conn, &file_id)? || deleted_documents.contains(&file_id) {
            continue;
        }
        let record = match serde_json::from_str::<serde_json::Value>(&record) {
            Ok(record) => record,
            Err(error) => {
                eprintln!("Malformed sync file record {file_id} (1 skipped row): {error}");
                continue;
            }
        };
        if record["deleted"] == true {
            continue;
        }
        let (Some(module_id), Some(file_type)) =
            (record["module"].as_str(), record["type"].as_str())
        else {
            eprintln!("Invalid sync file record {file_id} (1 skipped row): missing module/type");
            continue;
        };
        let have = conn
            .query_row("select 1 from files where id = ?1", [&file_id], |_| Ok(()))
            .optional()
            .map_err(db_err)?
            .is_some();
        if !have && module_exists(conn, module_id)? {
            missing.push(MissingFile {
                file_id,
                module_id: module_id.to_string(),
                file_type: file_type.to_string(),
            });
        }
    }
    // PDFs whose synced metadata arrived before their bytes. Deleted ones have
    // no row, and the documents row cascades with its module.
    let mut stmt = conn
        .prepare(
            "select id, module_id from documents d
             where not exists (select 1 from files f where f.id = d.id)",
        )
        .map_err(db_err)?;
    let pdfs = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    for (file_id, module_id) in pdfs {
        if !file_gone(conn, &file_id)?
            && !deleted_documents.contains(&file_id)
            && !missing.iter().any(|file| file.file_id == file_id)
        {
            missing.push(MissingFile {
                file_id,
                module_id,
                file_type: "application/pdf".into(),
            });
        }
    }
    Ok(missing)
}

fn pending_uploads(conn: &Connection) -> CommandResult<Vec<String>> {
    // A file deleted locally before it was uploaded no longer needs to be.
    conn.execute(
        "delete from sync_file_uploads where file_id not in (select id from files) or file_id in (select file_id from sync_files_gone)",
        [],
    )
    .map_err(db_err)?;
    // Retained bytes must not reupload a remotely tombstoned image.
    let doc = load_vault(conn)?;
    for (id, record) in string_entries(&doc, FILES_MAP) {
        if file_deleted(&record) {
            conn.execute("delete from sync_file_uploads where file_id = ?1", [id])
                .map_err(db_err)?;
        }
    }
    let mut stmt = conn
        .prepare("select file_id from sync_file_uploads")
        .map_err(db_err)?;
    let rows = stmt.query_map([], |row| row.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

fn store_file(
    conn: &Connection,
    files_dir: &std::path::Path,
    file_id: &str,
    module_id: &str,
    file_type: &str,
    bytes: &[u8],
) -> CommandResult<crate::FileType> {
    if !module_exists(conn, module_id)? {
        return Err("The image's note no longer exists".into());
    }
    let data_dir = files_dir.parent().ok_or("Invalid files directory")?;
    let path = crate::files::assets::path(data_dir, file_id)?;
    if !path.is_file() {
        crate::files::assets::write(data_dir, file_id, bytes)?;
    }
    let path_str = path
        .to_str()
        .ok_or("File path is not valid UTF-8")?
        .to_owned();
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    tx.execute(
        "insert or ignore into files (id, module_id, path, file_type) values (?1, ?2, ?3, ?4)",
        params![file_id, module_id, path_str, file_type],
    )
    .map_err(db_err)?;
    // Downloads can outrun the note update that publishes their references.
    // Keep this lease atomic with the file row, just like local answer uploads.
    if file_type.starts_with("image/") || file_type == "application/vnd.memnoter.drawing+json" {
        crate::asset_refs::retain_worksheet_asset(&tx, module_id, file_id, true)?;
        crate::asset_refs::publish_current(&tx, module_id)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(crate::FileType {
        id: file_id.to_string(),
        path: path_str,
        file_type: file_type.to_string(),
    })
}

pub fn sync_status(db: &Db) -> CommandResult<SyncStatus> {
    status(&*db.lock()?)
}

// Turns sync on (seeding the outbox) or replaces the stored account, e.g. a
// renewed token. `account` is the frontend's JSON.
pub fn sync_enable(db: &Db, account: String) -> CommandResult<()> {
    if db.data_dir.join(crate::worksheets::bank::DEV_MARKER).exists() { return Err("This development vault cannot sync".into()); }
    enable(&mut *db.lock()?, &account)?;
    Ok(())
}

pub fn sync_disable(db: &Db) -> CommandResult<()> {
    disable(&*db.lock()?)
}

pub fn sync_outbox(
    db: &Db,
    limit_bytes: i64,
    generation: String,
) -> CommandResult<Vec<OutboxEntry>> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    if !section_moves::published_transfers_supported() {
        let has_unpublished_transfers: bool = conn.query_row(
            "select exists(select 1 from sync_outbox where doc like 'r-move-%' and length(bytes)>0)",
            [], |row| row.get(0),
        ).map_err(db_err)?;
        if has_unpublished_transfers {
            return Err("Unpublished cross-note moves require compatible sync.".into());
        }
    }
    outbox(&conn, limit_bytes)
}

pub fn sync_ack(db: &Db, max_id: i64, generation: String) -> CommandResult<()> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    conn.execute("delete from sync_outbox where id <= ?1", [max_id])
        .map(|_| ())
        .map_err(db_err)
}

pub fn sync_set_cursor(db: &Db, cursor: i64, generation: String) -> CommandResult<()> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    if !is_enabled(&conn)? {
        return Ok(());
    }
    let previous = self::cursor(&conn)?;
    set_value(&conn, "cursor", previous.max(cursor))
}

pub fn sync_apply(
    data_dir: &Path,
    db: &Db,
    entries: Vec<RemoteEntry>,
    cursor: i64,
    generation: String,
) -> CommandResult<ApplyResult> {
    let mut conn = db.lock()?;
    check_generation(&conn, &generation)?;
    let result = apply_remote(&mut conn, &data_dir.join("files"), entries, cursor)?;
    Ok(result)
}

pub fn sync_snapshot(db: &Db, doc: String, generation: String) -> CommandResult<Option<Vec<u8>>> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    snapshot(&conn, &doc)
}

pub fn sync_missing_files(db: &Db, generation: String) -> CommandResult<Vec<MissingFile>> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    missing_files(&conn)
}

pub fn sync_pending_uploads(db: &Db, generation: String) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    pending_uploads(&conn)
}

// A drained vault outbox proves every queued tombstone is durable on the
// server. This also holds after seed replaces the outbox with a snapshot.
fn pending_deletes(conn: &Connection) -> CommandResult<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "select file_id from sync_file_deletes where not exists
         (select 1 from sync_outbox where doc = ?1)",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([VAULT_DOC], |row| row.get(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub fn sync_pending_deletes(db: &Db, generation: String) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    pending_deletes(&conn)
}

pub fn sync_delete_done(db: &Db, file_id: String, generation: String) -> CommandResult<()> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    conn.execute(
        "delete from sync_file_deletes where file_id = ?1",
        [file_id],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn sync_upload_done(db: &Db, file_id: String, generation: String) -> CommandResult<()> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    conn.execute(
        "delete from sync_file_uploads where file_id = ?1",
        [file_id],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn sync_store_file(
    data_dir: &Path,
    db: &Db,
    file_id: String,
    module_id: String,
    file_type: String,
    bytes: Vec<u8>,
    generation: String,
) -> CommandResult<crate::FileType> {
    let conn = db.lock()?;
    check_generation(&conn, &generation)?;
    let dir = data_dir.join("files");
    store_file(&conn, &dir, &file_id, &module_id, &file_type, &bytes)
}

// Finishes deletions the vault asked for, e.g. after a crash between storing
// the vault and removing the module's files.
pub fn sync_reconcile(data_dir: &Path, db: &Db, generation: String) -> CommandResult<ApplyResult> {
    let mut conn = db.lock()?;
    check_generation(&conn, &generation)?;
    if !is_enabled(&conn)? {
        return Ok(ApplyResult::default());
    }
    let current = cursor(&conn)?;
    apply_remote(&mut conn, &data_dir.join("files"), Vec::new(), current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::delete_module_data;
    use yrs::{GetString, Text, XmlFragment, XmlTextPrelim};

    fn db() -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("notes-sync-{}", uuid::Uuid::new_v4()));
        let db = crate::open_db(&dir).unwrap();
        (dir, db.conn.into_inner().unwrap())
    }

    fn text_update(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let content = doc.get_or_insert_text("t");
        let mut txn = doc.transact_mut();
        content.insert(&mut txn, 0, text);
        txn.encode_update_v1()
    }

    fn text_of(state: &[u8]) -> String {
        let doc = Doc::new();
        let content = doc.get_or_insert_text("t");
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
        let txn = doc.transact();
        content.get_string(&txn)
    }

    fn outbox_docs(conn: &Connection) -> Vec<String> {
        outbox(conn, i64::MAX)
            .unwrap()
            .into_iter()
            .map(|entry| entry.doc)
            .collect()
    }

    // A change made on another device, which has already seen this one's vault.
    fn vault_update_after(conn: &Connection, changes: &[(&str, Any)]) -> Vec<u8> {
        let doc = load_vault(conn).unwrap();
        let map = doc.get_or_insert_map(MODULES_MAP);
        let mut txn = doc.transact_mut();
        for (key, value) in changes {
            map.insert(&mut txn, *key, value.clone());
        }
        txn.encode_update_v1()
    }

    fn vault_update(changes: &[(&str, Any)]) -> Vec<u8> {
        let doc = Doc::new();
        let map = doc.get_or_insert_map(MODULES_MAP);
        let mut txn = doc.transact_mut();
        for (key, value) in changes {
            map.insert(&mut txn, *key, value.clone());
        }
        txn.encode_update_v1()
    }

    #[test]
    fn records_nothing_while_off() {
        let (_dir, conn) = db();
        conn.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');")
            .unwrap();
        assert!(!record_update(&conn, "m", &[1]).unwrap());
        assert!(!record_module(&conn, "m", VaultChange::Name("N")).unwrap());
        assert_eq!(status(&conn).unwrap().pending, 0);
    }

    #[test]
    fn enabling_seeds_vault_then_content() {
        let (_dir, mut conn) = db();
        let update = text_update("hello");
        conn.execute("insert into modules (id, name) values ('m', 'Maths')", [])
            .unwrap();
        conn.execute("insert into contents values ('m', X'')", [])
            .unwrap();
        conn.execute(
            "insert into contents_updates (module_id, bytes, created_at) values ('m', ?1, 0)",
            [&update],
        )
        .unwrap();
        enable(&mut conn, "{}").unwrap();
        assert_eq!(outbox_docs(&conn), vec!["vault", "m"]);
        let vault = vault_modules(&load_vault(&conn).unwrap());
        assert_eq!(vault["m"].name.as_deref(), Some("Maths"));

        // Enabling again only replaces the account.
        enable(&mut conn, "{\"token\":1}").unwrap();
        assert_eq!(outbox_docs(&conn).len(), 2);
        assert_eq!(
            status(&conn).unwrap().account.as_deref(),
            Some("{\"token\":1}")
        );

        record_update(&conn, "m", &[9]).unwrap();
        record_module(&conn, "m", VaultChange::Name("Physics")).unwrap();
        assert_eq!(outbox_docs(&conn), vec!["vault", "m", "m", "vault"]);
        assert_eq!(
            vault_modules(&load_vault(&conn).unwrap())["m"]
                .name
                .as_deref(),
            Some("Physics")
        );
    }

    #[test]
    fn outbox_batches_by_size_but_returns_at_least_one() {
        let (_dir, mut conn) = db();
        enable(&mut conn, "{}").unwrap();
        conn.execute("delete from sync_outbox", []).unwrap();
        for _ in 0..3 {
            conn.execute(
                "insert into sync_outbox (doc, bytes) values ('m', zeroblob(100))",
                [],
            )
            .unwrap();
        }
        assert_eq!(outbox(&conn, 10).unwrap().len(), 1);
        assert_eq!(outbox(&conn, 150).unwrap().len(), 2);
        assert_eq!(outbox(&conn, 1000).unwrap().len(), 3);
    }

    #[test]
    fn applies_remote_modules_content_and_cursor_together() {
        let (_dir, mut conn) = db();
        enable(&mut conn, "{}").unwrap();
        let entries = vec![
            RemoteEntry {
                seq: 3,
                doc: "m".into(),
                bytes: text_update("remote text"),
            },
            RemoteEntry {
                seq: 2,
                doc: VAULT_DOC.into(),
                bytes: vault_update(&[("m.name", "From iPad".into())]),
            },
        ];
        let files_dir = Path::new(conn.path().unwrap())
            .parent()
            .unwrap()
            .join("files");
        let result = apply_remote(&mut conn, &files_dir, entries, 3).unwrap();
        assert!(result.modules_changed);
        assert_eq!(result.updates.len(), 1);
        let name: String = conn
            .query_row("select name from modules where id = 'm'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "From iPad");
        assert_eq!(
            text_of(&snapshot(&conn, "m").unwrap().unwrap()),
            "remote text"
        );
        assert_eq!(cursor(&conn).unwrap(), 3);
        // Remote changes are not echoed back to the server.
        assert!(outbox_docs(&conn).iter().all(|doc| doc == VAULT_DOC));

        // The cursor never moves back.
        apply_remote(&mut conn, &files_dir, vec![], 1).unwrap();
        assert_eq!(cursor(&conn).unwrap(), 3);
    }

    #[test]
    fn remote_rename_and_delete() {
        let (_dir, mut conn) = db();
        conn.execute_batch("insert into modules (id, name) values ('m', 'Old'); insert into contents values ('m', X'');")
            .unwrap();
        enable(&mut conn, "{}").unwrap();
        let files_dir = Path::new(conn.path().unwrap())
            .parent()
            .unwrap()
            .join("files");
        let rename = vault_update_after(&conn, &[("m.name", "New".into())]);
        apply_remote(
            &mut conn,
            &files_dir,
            vec![RemoteEntry {
                seq: 1,
                doc: VAULT_DOC.into(),
                bytes: rename,
            }],
            1,
        )
        .unwrap();
        let name: String = conn
            .query_row("select name from modules where id = 'm'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "New");

        let delete = vault_update(&[("m.deleted", true.into())]);
        let files_dir = Path::new(conn.path().unwrap())
            .parent()
            .unwrap()
            .join("files");
        let result = apply_remote(
            &mut conn,
            &files_dir,
            vec![
                RemoteEntry {
                    seq: 2,
                    doc: VAULT_DOC.into(),
                    bytes: delete,
                },
                RemoteEntry {
                    seq: 3,
                    doc: "m".into(),
                    bytes: text_update("late edit"),
                },
            ],
            3,
        )
        .unwrap();
        assert_eq!(result.deleted, vec!["m".to_string()]);
        // Content for a deleted module is ignored.
        assert!(result.updates.is_empty());
    }

    #[test]
    fn content_before_its_vault_entry_creates_a_placeholder() {
        let (_dir, mut conn) = db();
        enable(&mut conn, "{}").unwrap();
        let files_dir = Path::new(conn.path().unwrap())
            .parent()
            .unwrap()
            .join("files");
        apply_remote(
            &mut conn,
            &files_dir,
            vec![RemoteEntry {
                seq: 1,
                doc: "n".into(),
                bytes: text_update("x"),
            }],
            1,
        )
        .unwrap();
        let name: String = conn
            .query_row("select name from modules where id = 'n'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Untitled");
        let named = vault_update(&[("n.name", "Biology".into())]);
        apply_remote(
            &mut conn,
            &files_dir,
            vec![RemoteEntry {
                seq: 2,
                doc: VAULT_DOC.into(),
                bytes: named,
            }],
            2,
        )
        .unwrap();
        let name: String = conn
            .query_row("select name from modules where id = 'n'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Biology");
    }

    #[test]
    fn snapshot_merges_state_and_updates() {
        let (_dir, conn) = db();
        let first = text_update("a");
        conn.execute("insert into modules (id, name) values ('m', 'M')", [])
            .unwrap();
        conn.execute("insert into contents values ('m', ?1)", [&first])
            .unwrap();
        // A second, independent insert from another client.
        let second = text_update("b");
        conn.execute(
            "insert into contents_updates (module_id, bytes, created_at) values ('m', ?1, 0)",
            [&second],
        )
        .unwrap();
        let text = text_of(&snapshot(&conn, "m").unwrap().unwrap());
        assert_eq!(text.len(), 2);
        assert!(snapshot(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn disabling_forgets_everything() {
        let (_dir, mut conn) = db();
        enable(&mut conn, "{}").unwrap();
        disable(&conn).unwrap();
        assert!(!is_enabled(&conn).unwrap());
        assert_eq!(status(&conn).unwrap().pending, 0);
    }

    // Moves everything in `from`'s outbox to `to`, as the server would.
    fn transfer(from: &Connection, to: &mut Connection, seq: &mut i64) -> ApplyResult {
        let entries: Vec<RemoteEntry> = outbox(from, i64::MAX)
            .unwrap()
            .into_iter()
            .filter(|entry| !entry.bytes.is_empty())
            .map(|entry| {
                *seq += 1;
                RemoteEntry {
                    seq: *seq,
                    doc: entry.doc,
                    bytes: entry.bytes,
                }
            })
            .collect();
        from.execute("delete from sync_outbox", []).unwrap();
        apply_remote(
            to,
            &Path::new(to.path().unwrap())
                .parent()
                .unwrap()
                .join("files"),
            entries,
            *seq,
        )
        .unwrap()
    }

    #[test]
    fn pdf_deletions_wait_for_vault_ack_and_remote_cleanup_does_not_queue_deletes() {
        for module_deletion in [false, true] {
            let a_dir = std::env::temp_dir().join(format!("pdf-delete-{}", uuid::Uuid::new_v4()));
            let a = crate::Core::open(&a_dir).unwrap();
            let module = crate::create_module(&a.db, "PDFs".into()).unwrap();
            enable(&mut a.db.lock().unwrap(), "{}").unwrap();
            let mut ids = Vec::new();
            for name in ["First.pdf", "Second.pdf"] {
                ids.push(
                    crate::add_document_bytes(
                        &a_dir,
                        &a.db,
                        module.clone(),
                        name.into(),
                        b"%PDF-1.7".to_vec(),
                    )
                    .unwrap()
                    .id,
                );
            }
            let (b_dir, mut b) = db();
            enable(&mut b, "{}").unwrap();
            let mut seq = 0;
            transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
            b.execute("delete from sync_outbox", []).unwrap();
            for id in &ids {
                store_file(
                    &b,
                    &b_dir.join("files"),
                    id,
                    &module,
                    "application/pdf",
                    b"%PDF-1.7",
                )
                .unwrap();
            }
            // Module deletion must also handle metadata whose file receipt is missing.
            if module_deletion {
                a.db.lock()
                    .unwrap()
                    .execute("delete from files where id=?1", [&ids[1]])
                    .unwrap();
                crate::delete_module(&a_dir, &a.db, module).unwrap();
            } else {
                for id in &ids {
                    crate::delete_document(&a_dir, &a.db, id.clone()).unwrap();
                }
            }
            let conn = a.db.lock().unwrap();
            assert!(pending_deletes(&conn).unwrap().is_empty());
            assert!(pending_uploads(&conn).unwrap().is_empty());
            let vault = load_vault(&conn).unwrap();
            assert!(string_entries(&vault, FILES_MAP).is_empty());
            assert_eq!(deleted_documents(&vault), ids.iter().cloned().collect());
            assert_eq!(
                conn.query_row("select count(*) from sync_file_deletes", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            transfer(&conn, &mut b, &mut seq);
            let mut queued = pending_deletes(&conn).unwrap();
            queued.sort();
            ids.sort();
            assert_eq!(queued, ids);
            assert!(pending_deletes(&b).unwrap().is_empty());
            assert_eq!(
                b.query_row("select count(*) from sync_file_deletes", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(missing_files(&b).unwrap().is_empty());
            assert!(string_entries(&load_vault(&b).unwrap(), FILES_MAP).is_empty());
            for id in &ids {
                assert!(!b_dir.join("files").join(id).exists());
                assert!(!a_dir.join("files").join(id).exists());
            }
            drop(conn);
            drop(a);
            drop(b);
            std::fs::remove_dir_all(a_dir).unwrap();
            std::fs::remove_dir_all(b_dir).unwrap();
        }
    }

    #[test]
    fn pdf_gone_stops_downloads_without_an_image_tombstone() {
        let a_dir = std::env::temp_dir().join(format!("pdf-gone-{}", uuid::Uuid::new_v4()));
        let a = crate::Core::open(&a_dir).unwrap();
        let module = crate::create_module(&a.db, "PDFs".into()).unwrap();
        let pdf = crate::add_document_bytes(
            &a_dir,
            &a.db,
            module,
            "Book.pdf".into(),
            b"%PDF-1.7".to_vec(),
        )
        .unwrap();
        enable(&mut a.db.lock().unwrap(), "{}").unwrap();
        let (b_dir, mut b) = db();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        assert_eq!(missing_files(&b).unwrap().len(), 1);
        drop(b);
        let b_db = crate::open_db(&b_dir).unwrap();
        let epoch = generation(&b_db.lock().unwrap()).unwrap();
        sync_file_gone(&b_db, pdf.id.clone(), epoch).unwrap();
        let b = b_db.lock().unwrap();
        assert!(missing_files(&b).unwrap().is_empty());
        seed(&b).unwrap();
        assert!(missing_files(&b).unwrap().is_empty());
        assert!(pending_uploads(&b).unwrap().is_empty());
        assert!(string_entries(&load_vault(&b).unwrap(), FILES_MAP).is_empty());
        assert!(deleted_documents(&load_vault(&b).unwrap()).contains(&pdf.id));
        b.execute("delete from sync_outbox", []).unwrap();
        assert!(pending_deletes(&b).unwrap().is_empty());
        drop(b);
        drop(b_db);
        drop(a);
        std::fs::remove_dir_all(a_dir).unwrap();
        std::fs::remove_dir_all(b_dir).unwrap();
    }

    #[test]
    fn pdf_metadata_precedes_bytes_and_syncs_rename_delete_and_module_deletion() {
        let a_dir = std::env::temp_dir().join(format!("pdf-sync-{}", uuid::Uuid::new_v4()));
        let a = crate::Core::open(&a_dir).unwrap();
        let module = crate::create_module(&a.db, "PDFs".into()).unwrap();
        let pdf = crate::add_document_bytes(
            &a_dir,
            &a.db,
            module.clone(),
            "Book.pdf".into(),
            b"%PDF-1.7".to_vec(),
        )
        .unwrap();
        // Enabling sync must seed documents imported while offline.
        enable(&mut a.db.lock().unwrap(), "{}").unwrap();
        {
            // Older builds read the images map, so PDFs must stay out of it.
            let conn = a.db.lock().unwrap();
            let vault = load_vault(&conn).unwrap();
            assert!(!string_entries(&vault, FILES_MAP)
                .iter()
                .any(|(id, _)| *id == pdf.id));
            assert_eq!(pending_uploads(&conn).unwrap(), vec![pdf.id.clone()]);
        }
        let (b_dir, mut b) = db();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        assert_eq!(
            b.query_row("select name from documents where id=?1", [&pdf.id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Book.pdf"
        );
        assert!(!b_dir.join("files").join(&pdf.id).exists());
        assert_eq!(missing_files(&b).unwrap().len(), 1);
        let bytes = std::fs::read(a_dir.join("files").join(&pdf.id)).unwrap();
        store_file(
            &b,
            &b_dir.join("files"),
            &pdf.id,
            &module,
            "application/pdf",
            &bytes,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(b_dir.join("files").join(&pdf.id)).unwrap(),
            bytes
        );
        assert!(missing_files(&b).unwrap().is_empty());
        crate::rename_document(&a.db, pdf.id.clone(), "Renamed.pdf".into()).unwrap();
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        assert_eq!(
            b.query_row("select name from documents", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Renamed.pdf"
        );
        crate::delete_document(&a_dir, &a.db, pdf.id.clone()).unwrap();
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        assert_eq!(
            b.query_row("select count(*) from documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!b_dir.join("files").join(&pdf.id).exists());
        assert!(missing_files(&b).unwrap().is_empty());
        let second = crate::add_document_bytes(
            &a_dir,
            &a.db,
            module.clone(),
            "Second.pdf".into(),
            bytes.clone(),
        )
        .unwrap();
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        store_file(
            &b,
            &b_dir.join("files"),
            &second.id,
            &module,
            "application/pdf",
            &bytes,
        )
        .unwrap();
        crate::delete_module(&a_dir, &a.db, module).unwrap();
        transfer(&a.db.lock().unwrap(), &mut b, &mut seq);
        assert_eq!(
            b.query_row("select count(*) from documents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!b_dir.join("files").join(&second.id).exists());
        drop(b);
        drop(a);
        std::fs::remove_dir_all(a_dir).unwrap();
        std::fs::remove_dir_all(b_dir).unwrap();
    }

    fn add_card(conn: &Connection, module: &str, card: &str) {
        conn.execute(
            "insert into cards (id, module_id, kind, front, back, due_at, created_at, updated_at)
             values (?1, ?2, 'basic', '{}', '{}', 0, 0, 0)",
            params![card, module],
        )
        .unwrap();
    }

    fn review(conn: &Connection, card: &str, reps: i64, at: i64) -> i64 {
        conn.execute(
            "update cards set reps = ?2, last_review_at = ?3, due_at = ?3 + 86400000, state = 2 where id = ?1",
            params![card, reps, at],
        )
        .unwrap();
        conn.execute(
            "insert into review_log (card_id, rating, review_time, fsrs_model, state, schedule_status,
                 due_at, stability, stability_fast, difficulty, scheduled_days, learning_step, sync_id)
             values (?1, 3, ?2, 'm', 0, 'new', 0, 0, 0, 0, 0, 0, lower(hex(randomblob(16))))",
            params![card, at],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn reps(conn: &Connection, card: &str) -> i64 {
        conn.query_row("select reps from cards where id = ?1", [card], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn log_count(conn: &Connection) -> i64 {
        conn.query_row("select count(*) from review_log", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn reviews_and_undo_reach_the_other_device() {
        let (_a_dir, mut a) = db();
        let (_b_dir, mut b) = db();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');")
            .unwrap();
        add_card(&a, "m", "card");
        // Reviewed before sync was on: seeding uploads the history.
        review(&a, "card", 1, 1000);
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        // B indexes the note's cards only now; they get the synced state.
        add_card(&b, "m", "card");
        apply_reviews(&b, "m").unwrap();
        assert_eq!(reps(&b, "card"), 1);
        assert_eq!(log_count(&b), 1);

        // A review on B reaches A.
        let log = review(&b, "card", 2, 2000);
        assert!(record_review(&b, "card", Some(log), None).unwrap());
        let result = transfer(&b, &mut a, &mut seq);
        assert!(result.reviews_changed);
        assert_eq!(reps(&a, "card"), 2);
        assert_eq!(log_count(&a), 2);

        // Undoing it on A takes it back on B.
        let sync_id: String = a
            .query_row("delete from review_log where id = (select max(id) from review_log) returning sync_id", [], |row| row.get(0))
            .unwrap();
        a.execute(
            "update cards set reps = 1, last_review_at = 1000 where id = 'card'",
            [],
        )
        .unwrap();
        record_review(&a, "card", None, Some(&sync_id)).unwrap();
        transfer(&a, &mut b, &mut seq);
        assert_eq!(reps(&b, "card"), 1);
        assert_eq!(log_count(&b), 1);
    }

    fn section_text_update(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        root.insert(&mut txn, 0, XmlTextPrelim::new(text));
        txn.encode_update_v1()
    }

    fn section_text(conn: &Connection, module: &str) -> String {
        let doc = crate::worksheets::load(conn, module).unwrap();
        let root = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        root.children(&txn)
            .filter_map(|node| node.into_xml_text())
            .map(|text| text.get_string(&txn))
            .collect()
    }

    fn insert_test_chapter(root: &impl XmlFragment, txn: &mut yrs::TransactionMut<'_>, at: u32) {
        use yrs::Xml;
        let heading = root.insert(txn, at, yrs::XmlElementPrelim::empty("heading"));
        heading.insert_attribute(txn, "level", 1);
        heading.insert_attribute(txn, "data-toc-id", "chapter");
        root.insert(txn, at + 1, XmlTextPrelim::new("card"));
    }

    struct SectionTransfer {
        a: Db,
        b: Db,
        source: String,
        destination: String,
        seq: i64,
    }

    impl SectionTransfer {
        fn new() -> Self {
            let (a_dir, _) = db();
            let (b_dir, _) = db();
            let a = crate::open_db(&a_dir).unwrap();
            let b = crate::open_db(&b_dir).unwrap();
            let source = crate::create_module(&a, "Source".into()).unwrap();
            let destination = crate::create_module(&a, "Destination".into()).unwrap();
            let doc = Doc::new();
            let root = doc.get_or_insert_xml_fragment("default");
            let bytes = {
                let mut txn = doc.transact_mut();
                insert_test_chapter(&root, &mut txn, 0);
                txn.encode_update_v1()
            };
            crate::content::add_update(&a, source.clone(), bytes).unwrap();
            Self::index(&a, &source, true);
            review(&a.lock().unwrap(), "card", 1, 1000);
            enable(&mut a.lock().unwrap(), "{}").unwrap();
            enable(&mut b.lock().unwrap(), "{}").unwrap();
            let mut seq = 0;
            transfer(&a.lock().unwrap(), &mut b.lock().unwrap(), &mut seq);
            Self::index(&b, &source, true);
            assert_eq!(reps(&b.lock().unwrap(), "card"), 1);
            Self {
                a,
                b,
                source,
                destination,
                seq,
            }
        }

        fn index(db: &Db, module: &str, contains_card: bool) {
            let cards = if contains_card {
                vec![serde_json::from_value(serde_json::json!({
                    "id": "card", "kind": "basic", "front": "Question", "back": "Answer"
                }))
                .unwrap()]
            } else {
                vec![]
            };
            assert!(crate::cards::sync_cards(db, module.into(), cards)
                .unwrap()
                .is_empty());
        }

        fn move_on_a(&self) {
            self.try_move_on_a(Some(3)).unwrap();
        }

        fn try_move_on_a(&self, minimum: Option<u64>) -> CommandResult<Vec<ContentUpdate>> {
            let (edits, restore_source) = {
                let conn = self.a.lock().unwrap();
                let source = crate::worksheets::load(&conn, &self.source).unwrap();
                let root = source.get_or_insert_xml_fragment("default");
                let images = crate::files::assets::note_images(&root, &source.transact());
                let mut restore_source = None;
                let edits = [&self.source, &self.destination].into_iter().map(|module| {
                    let (state, latest): (Vec<u8>, i64) = conn.query_row(
                        "select state, coalesce((select max(id) from contents_updates where module_id=?1),0)
                         from contents where module_id=?1",
                        [module], |row| Ok((row.get(0)?, row.get(1)?)),
                    ).unwrap();
                    let doc = crate::worksheets::load(&conn, module).unwrap();
                    let text = doc.get_or_insert_xml_fragment("default");
                    let mut txn = doc.transact_mut();
                    if module == &self.source {
                        let length = text.len(&txn);
                        text.remove_range(&mut txn, 0, length);
                    } else {
                        let end = text.len(&txn);
                        insert_test_chapter(&text, &mut txn, end);
                        append_test_images(&text, &mut txn, &images);
                    }
                    let bytes = txn.encode_update_v1();
                    drop(txn);
                    if module == &self.source {
                        let mut txn = doc.transact_mut();
                        insert_test_chapter(&text, &mut txn, 0);
                        append_test_images(&text, &mut txn, &images);
                        restore_source = Some(txn.encode_update_v1());
                    }
                    serde_json::from_value(serde_json::json!({
                        "moduleId": module, "expectedState": state, "expectedUpdateId": latest,
                        "bytes": bytes
                    })).unwrap()
                }).collect();
                (edits, restore_source)
            };
            let cards = vec!["card".into()];
            let headings = vec!["chapter".into()];
            if let Some(minimum) = minimum {
                crate::section_moves::move_section_at_protocol(
                    &self.a,
                    edits,
                    cards,
                    headings,
                    restore_source,
                    minimum,
                )
            } else {
                crate::section_moves::move_section(&self.a, edits, cards, headings, restore_source)
            }
        }
    }

    fn append_test_images(
        root: &impl XmlFragment,
        txn: &mut yrs::TransactionMut<'_>,
        images: &HashSet<String>,
    ) {
        use yrs::Xml;
        for id in images {
            let image = root.push_back(txn, yrs::XmlElementPrelim::empty("image"));
            image.insert_attribute(txn, "fileId", id.as_str());
        }
    }

    #[test]
    fn released_protocol_blocks_cross_note_moves_before_either_note_is_written() {
        let pair = SectionTransfer::new();
        let err = pair.try_move_on_a(None).unwrap_err();
        assert!(err.contains("newer sync service"));
        let conn = pair.a.lock().unwrap();
        assert_eq!(section_text(&conn, &pair.source), "card");
        assert!(section_text(&conn, &pair.destination).is_empty());
        assert!(outbox(&conn, i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn a_stale_source_delete_cannot_tombstone_the_moved_image() {
        let mut pair = SectionTransfer::new();
        let image = crate::save_file(
            &pair.a.data_dir,
            &pair.a,
            pair.source.clone(),
            b"image".to_vec(),
            "image/png".into(),
        )
        .unwrap();
        let bytes = {
            let doc = crate::worksheets::load(&pair.a.lock().unwrap(), &pair.source).unwrap();
            let root = doc.get_or_insert_xml_fragment("default");
            let mut txn = doc.transact_mut();
            append_test_images(&root, &mut txn, &HashSet::from([image.id.clone()]));
            txn.encode_update_v1()
        };
        crate::content::add_update(&pair.a, pair.source.clone(), bytes).unwrap();
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        store_file(
            &pair.b.lock().unwrap(),
            &pair.b.data_dir.join("files"),
            &image.id,
            &pair.source,
            "image/png",
            b"image",
        )
        .unwrap();
        pair.move_on_a();
        let copied = {
            let conn = pair.a.lock().unwrap();
            let doc = crate::worksheets::load(&conn, &pair.destination).unwrap();
            let root = doc.get_or_insert_xml_fragment("default");
            let ids = crate::files::assets::note_images(&root, &doc.transact());
            assert_eq!(ids.len(), 1);
            let copy = ids.into_iter().next().unwrap();
            assert_ne!(copy, image.id);
            copy
        };
        crate::delete_module(&pair.b.data_dir, &pair.b, pair.source.clone()).unwrap();
        let stale_deletes = pair.b.lock().unwrap();
        assert!(stale_deletes
            .query_row(
                "select exists(select 1 from sync_file_deletes where file_id=?1)",
                [&image.id],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        drop(stale_deletes);
        transfer(
            &pair.b.lock().unwrap(),
            &mut pair.a.lock().unwrap(),
            &mut pair.seq,
        );
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        let missing = missing_files(&pair.b.lock().unwrap()).unwrap();
        assert!(missing
            .iter()
            .any(|file| file.file_id == copied && file.module_id == pair.destination));
        let local =
            crate::read_file(&pair.a.data_dir, &pair.a, pair.destination.clone(), copied).unwrap();
        assert_eq!(
            serde_json::to_value(local).unwrap()["bytes"],
            serde_json::json!(b"image")
        );
    }

    #[test]
    fn a_concurrent_offline_edit_has_one_recovery_copy_and_only_one_card_owner() {
        let mut pair = SectionTransfer::new();
        let offline_edit = {
            let doc = crate::worksheets::load(&pair.b.lock().unwrap(), &pair.source).unwrap();
            let root = doc.get_or_insert_xml_fragment("default");
            let mut txn = doc.transact_mut();
            let text = root.get(&txn, 1).unwrap().into_xml_text().unwrap();
            text.insert(&mut txn, 4, " edited offline");
            root.insert(&mut txn, 2, XmlTextPrelim::new(" with a new block"));
            txn.encode_update_v1()
        };
        crate::content::add_update(&pair.b, pair.source.clone(), offline_edit).unwrap();
        pair.move_on_a();
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        transfer(
            &pair.b.lock().unwrap(),
            &mut pair.a.lock().unwrap(),
            &mut pair.seq,
        );
        for db in [&pair.a, &pair.b] {
            let copy: String = {
                let conn = db.lock().unwrap();
                let copies = conn
                    .prepare("select id from modules where name = 'Recovered chapter from Source'")
                    .unwrap()
                    .query_map([], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                assert_eq!(copies.len(), 1);
                assert_eq!(
                    section_text(&conn, &copies[0]),
                    "card edited offline with a new block"
                );
                assert_eq!(
                    section_text(&conn, &pair.source),
                    "",
                    "source on {}",
                    db.data_dir.display()
                );
                assert_eq!(section_text(&conn, &pair.destination), "card");
                copies[0].clone()
            };
            SectionTransfer::index(db, &copy, true);
            SectionTransfer::index(db, &pair.destination, true);
            let conn = db.lock().unwrap();
            assert_eq!(reps(&conn, "card"), 1);
            let owner: String = conn
                .query_row("select module_id from cards where id='card'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(owner, pair.destination);
        }
    }

    #[test]
    fn concurrent_destination_delete_restores_the_same_section_on_both_devices() {
        for deletion_arrives_first in [true, false] {
            let mut pair = SectionTransfer::new();
            pair.move_on_a();
            crate::delete_module(&pair.b.data_dir, &pair.b, pair.destination.clone()).unwrap();
            if deletion_arrives_first {
                transfer(
                    &pair.b.lock().unwrap(),
                    &mut pair.a.lock().unwrap(),
                    &mut pair.seq,
                );
            }
            transfer(
                &pair.a.lock().unwrap(),
                &mut pair.b.lock().unwrap(),
                &mut pair.seq,
            );
            if !deletion_arrives_first {
                transfer(
                    &pair.b.lock().unwrap(),
                    &mut pair.a.lock().unwrap(),
                    &mut pair.seq,
                );
            }
            for db in [&pair.a, &pair.b] {
                SectionTransfer::index(db, &pair.source, true);
                let conn = db.lock().unwrap();
                assert_eq!(section_text(&conn, &pair.source), "card");
                assert!(!module_exists(&conn, &pair.destination).unwrap());
                assert_eq!(reps(&conn, "card"), 1);
                assert_eq!(log_count(&conn), 1);
            }
        }
    }

    #[test]
    fn deleting_the_destination_after_observing_the_move_does_not_restore_the_chapter() {
        let mut pair = SectionTransfer::new();
        pair.move_on_a();
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        crate::delete_module(&pair.b.data_dir, &pair.b, pair.destination.clone()).unwrap();
        transfer(
            &pair.b.lock().unwrap(),
            &mut pair.a.lock().unwrap(),
            &mut pair.seq,
        );
        let conn = pair.a.lock().unwrap();
        assert!(!module_exists(&conn, &pair.destination).unwrap());
        assert!(section_text(&conn, &pair.source).is_empty());
    }

    fn transfer_entry(pair: &SectionTransfer) -> OutboxEntry {
        outbox(&pair.a.lock().unwrap(), i64::MAX)
            .unwrap()
            .into_iter()
            .find(|entry| entry.doc.starts_with(section_moves::SYNC_PREFIX))
            .unwrap()
    }

    #[test]
    fn a_transfer_waits_for_note_history_before_persisting_its_cut() {
        let pair = SectionTransfer::new();
        let (fresh_dir, mut fresh) = db();
        enable(&mut fresh, "{}").unwrap();
        let vault = snapshot(&pair.a.lock().unwrap(), VAULT_DOC)
            .unwrap()
            .unwrap();
        let source = snapshot(&pair.a.lock().unwrap(), &pair.source)
            .unwrap()
            .unwrap();
        let prerequisite = section_text_update("Destination prefix");
        crate::content::add_update(&pair.a, pair.destination.clone(), prerequisite.clone())
            .unwrap();
        pair.move_on_a();
        let movement = transfer_entry(&pair);
        let pull = |conn: &mut Connection, seq, doc, bytes| {
            apply_remote(
                conn,
                &fresh_dir.join("files"),
                vec![RemoteEntry { seq, doc, bytes }],
                seq,
            )
            .unwrap()
        };
        pull(&mut fresh, 1, VAULT_DOC.into(), vault);
        assert!(pull(&mut fresh, 2, movement.doc, movement.bytes)
            .updates
            .is_empty());
        assert!(pull(&mut fresh, 3, pair.source.clone(), source)
            .updates
            .iter()
            .all(|u| u.module_id == pair.source));
        assert_eq!(section_text(&fresh, &pair.source), "card");
        let updates = pull(&mut fresh, 4, pair.destination.clone(), prerequisite).updates;
        let source_update = updates.iter().find(|u| u.module_id == pair.source).unwrap();
        assert!(section_text(&fresh, &pair.source).is_empty());
        assert_eq!(
            section_text(&fresh, &pair.destination),
            "Destination prefixcard"
        );
        drop(fresh);
        let db = crate::open_db(&fresh_dir).unwrap();
        crate::save_compaction(&db, pair.source, Vec::new(), source_update.update.id).unwrap();
    }

    #[test]
    fn destination_snapshot_before_the_source_prerequisite_keeps_the_card_id() {
        let mut pair = SectionTransfer::new();
        let prerequisite = section_text_update("Late source history");
        crate::content::add_update(&pair.a, pair.source.clone(), prerequisite.clone()).unwrap();
        pair.move_on_a();
        let movement = transfer_entry(&pair);
        let destination = snapshot(&pair.a.lock().unwrap(), &pair.destination).unwrap();
        // An acknowledged move may be embedded in a later compacted snapshot
        // of the destination, while the source prerequisite is in another frame.
        assert_eq!(destination, Some(Vec::new()));
        pair.a
            .lock()
            .unwrap()
            .execute("delete from sync_outbox", [])
            .unwrap();
        let destination = snapshot(&pair.a.lock().unwrap(), &pair.destination)
            .unwrap()
            .unwrap();
        for (doc, bytes) in [
            (movement.doc, movement.bytes),
            (pair.destination.clone(), destination),
        ] {
            pair.seq += 1;
            apply_remote(
                &mut pair.b.lock().unwrap(),
                &pair.b.data_dir.join("files"),
                vec![RemoteEntry {
                    seq: pair.seq,
                    doc,
                    bytes,
                }],
                pair.seq,
            )
            .unwrap();
        }
        assert_eq!(
            section_text(&pair.b.lock().unwrap(), &pair.destination),
            "card"
        );
        SectionTransfer::index(&pair.b, &pair.destination, true);
        pair.seq += 1;
        apply_remote(
            &mut pair.b.lock().unwrap(),
            &pair.b.data_dir.join("files"),
            vec![RemoteEntry {
                seq: pair.seq,
                doc: pair.source.clone(),
                bytes: prerequisite,
            }],
            pair.seq,
        )
        .unwrap();
        let conn = pair.b.lock().unwrap();
        assert!(section_text(&conn, &pair.source).is_empty());
        assert_eq!(reps(&conn, "card"), 1);
        let owner: String = conn
            .query_row("select module_id from cards where id='card'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(owner, pair.destination);
    }

    #[test]
    fn upgrade_applies_a_move_cached_as_a_review_past_the_cursor() {
        let pair = SectionTransfer::new();
        pair.move_on_a();
        let movement = transfer_entry(&pair);
        {
            let conn = pair.b.lock().unwrap();
            conn.execute(
                "insert into sync_docs(doc,state) values (?1,?2)",
                params![movement.doc, movement.bytes],
            )
            .unwrap();
            set_value(&conn, "cursor", 100).unwrap();
            // Open the database at the schema the released client left behind.
            let version: i64 = conn
                .query_row("pragma user_version", [], |r| r.get(0))
                .unwrap();
            conn.pragma_update(None, "user_version", version - 1)
                .unwrap();
        }
        let upgraded = crate::open_db(&pair.b.data_dir).unwrap();
        let generation = generation(&upgraded.lock().unwrap()).unwrap();
        let result = sync_reconcile(&upgraded.data_dir, &upgraded, generation).unwrap();
        assert_eq!(result.updates.len(), 2);
        let conn = upgraded.lock().unwrap();
        assert_eq!(cursor(&conn).unwrap(), 100);
        assert!(section_text(&conn, &pair.source).is_empty());
        assert_eq!(section_text(&conn, &pair.destination), "card");
    }

    #[test]
    fn fresh_device_keeps_moved_card_history_after_a_legacy_source_drop() {
        let mut pair = SectionTransfer::new();
        pair.move_on_a();
        let (fresh_dir, _) = db();
        let fresh = crate::open_db(&fresh_dir).unwrap();
        enable(&mut fresh.lock().unwrap(), "{}").unwrap();
        let vault = snapshot(&pair.a.lock().unwrap(), VAULT_DOC)
            .unwrap()
            .unwrap();
        crate::delete_module(&pair.b.data_dir, &pair.b, pair.source.clone()).unwrap();
        let legacy_drop = outbox(&pair.b.lock().unwrap(), i64::MAX).unwrap();
        assert!(legacy_drop
            .iter()
            .any(|entry| entry.doc == review_doc_id(&pair.source) && entry.bytes.is_empty()));
        let mut replay = vec![(VAULT_DOC.into(), vault)];
        replay.extend(
            legacy_drop
                .into_iter()
                .filter(|e| e.doc == VAULT_DOC)
                .map(|e| (e.doc, e.bytes)),
        );
        replay.extend(
            outbox(&pair.a.lock().unwrap(), i64::MAX)
                .unwrap()
                .into_iter()
                .filter(|e| {
                    e.doc == carried_reviews_id(&pair.source)
                        || e.doc.starts_with(section_moves::SYNC_PREFIX)
                })
                .map(|e| (e.doc, e.bytes)),
        );
        let entries = replay
            .into_iter()
            .map(|(doc, bytes)| {
                pair.seq += 1;
                RemoteEntry {
                    seq: pair.seq,
                    doc,
                    bytes,
                }
            })
            .collect();
        apply_remote(
            &mut fresh.lock().unwrap(),
            &fresh_dir.join("files"),
            entries,
            pair.seq,
        )
        .unwrap();
        SectionTransfer::index(&fresh, &pair.destination, true);
        let conn = fresh.lock().unwrap();
        assert!(!module_exists(&conn, &pair.source).unwrap());
        assert_eq!(section_text(&conn, &pair.destination), "card");
        assert_eq!(reps(&conn, "card"), 1);
        assert_eq!(log_count(&conn), 1);
    }

    #[test]
    fn deleting_both_notes_removes_the_transfer_payload_and_queues_a_cloud_drop() {
        let pair = SectionTransfer::new();
        pair.move_on_a();
        let movement = transfer_entry(&pair);
        for module in [pair.source, pair.destination] {
            crate::delete_module(&pair.a.data_dir, &pair.a, module).unwrap();
        }
        let conn = pair.a.lock().unwrap();
        let updates = outbox(&conn, i64::MAX).unwrap();
        assert!(updates
            .iter()
            .any(|entry| entry.doc == movement.doc && entry.bytes.is_empty()));
        assert!(updates
            .iter()
            .all(|entry| entry.doc != movement.doc || entry.bytes.is_empty()));
        let stored: i64 = conn
            .query_row("select count(*) from sync_section_moves", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn split_pulls_move_cards_before_the_open_destination_indexes() {
        let mut pair = SectionTransfer::new();
        crate::content::add_update(
            &pair.a,
            pair.destination.clone(),
            section_text_update("intro "),
        )
        .unwrap();
        pair.move_on_a();

        // The receiver indexes the open destination immediately after each
        // batch. Its closed source never runs the background indexer here.
        let mut saw_move = false;
        let pending = outbox(&pair.a.lock().unwrap(), i64::MAX).unwrap();
        assert!(pending.len() > 1);
        let last_outbox_id = pending.last().unwrap().id;
        for entry in pending {
            pair.seq += 1;
            let result = apply_remote(
                &mut pair.b.lock().unwrap(),
                &pair.b.data_dir.join("files"),
                vec![RemoteEntry {
                    doc: entry.doc,
                    seq: pair.seq,
                    bytes: entry.bytes,
                }],
                pair.seq,
            )
            .unwrap();
            if result
                .updates
                .iter()
                .any(|update| update.module_id == pair.destination)
            {
                let contains_card = {
                    let conn = pair.b.lock().unwrap();
                    section_text(&conn, &pair.destination).contains("card")
                };
                SectionTransfer::index(&pair.b, &pair.destination, contains_card);
                if contains_card && !saw_move {
                    saw_move = true;
                    assert!(result
                        .updates
                        .iter()
                        .any(|update| update.module_id == pair.source));
                }
            }
        }
        assert!(saw_move);
        let generation = generation(&pair.a.lock().unwrap()).unwrap();
        for note in [&pair.source, &pair.destination] {
            assert_eq!(
                sync_snapshot(&pair.a, note.clone(), generation.clone()).unwrap(),
                Some(vec![])
            );
        }
        sync_ack(&pair.a, last_outbox_id, generation.clone()).unwrap();
        assert!(
            !sync_snapshot(&pair.a, pair.destination.clone(), generation)
                .unwrap()
                .unwrap()
                .is_empty()
        );
        let conn = pair.b.lock().unwrap();
        assert!(section_text(&conn, &pair.source).is_empty());
        let module: String = conn
            .query_row("select module_id from cards where id='card'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(module, pair.destination);
        assert_eq!(reps(&conn, "card"), 1);
        assert_eq!(log_count(&conn), 1);
    }

    #[test]
    fn late_source_review_merges_history_without_overriding_the_destination_undo() {
        let mut pair = SectionTransfer::new();
        {
            let b = pair.b.lock().unwrap();
            let log = review(&b, "card", 2, 2000);
            record_review(&b, "card", Some(log), None).unwrap();
        }
        pair.move_on_a();
        crate::cards::undo_review(
            &pair.a,
            "card".into(),
            1,
            serde_json::from_value(serde_json::json!({
                "state": 0, "scheduleStatus": "new", "dueAt": 0,
                "stability": 0, "stabilityFast": 0, "difficulty": 0, "scheduledDays": 0,
                "learningStep": 0, "reps": 0, "lapses": 0, "lastReviewAt": null
            }))
            .unwrap(),
            None,
            1000,
        )
        .unwrap();

        // A has committed the move and undo before B's offline source review
        // reaches it. B gets the move after having recorded the source review.
        transfer(
            &pair.b.lock().unwrap(),
            &mut pair.a.lock().unwrap(),
            &mut pair.seq,
        );
        assert_eq!(reps(&pair.a.lock().unwrap(), "card"), 0);
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        for db in [&pair.a, &pair.b] {
            SectionTransfer::index(db, &pair.destination, true);
            let conn = db.lock().unwrap();
            assert_eq!(reps(&conn, "card"), 0);
            let reviews: Vec<i64> = conn
                .prepare("select review_time from review_log where card_id='card'")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(reviews, vec![2000]);
        }
    }

    #[test]
    fn deleting_the_source_keeps_the_moved_cards_review_log_in_sync() {
        let mut pair = SectionTransfer::new();
        {
            let b = pair.b.lock().unwrap();
            let log = review(&b, "card", 2, 2000);
            record_review(&b, "card", Some(log), None).unwrap();
        }
        pair.move_on_a();
        crate::delete_module(&pair.a.data_dir, &pair.a, pair.source.clone()).unwrap();
        let retired_reviews = review_doc_id(&pair.source);

        // A server drop would erase the canonical review log. This still
        // applies when the move and delete were queued in the same push.
        assert!(!outbox(&pair.a.lock().unwrap(), i64::MAX)
            .unwrap()
            .iter()
            .any(|entry| entry.doc == retired_reviews && entry.bytes.is_empty()));
        transfer(
            &pair.b.lock().unwrap(),
            &mut pair.a.lock().unwrap(),
            &mut pair.seq,
        );
        // With no destination review or undo yet, the offline grade still
        // supplies the schedule through the retained source review document.
        assert_eq!(reps(&pair.a.lock().unwrap(), "card"), 2);
        transfer(
            &pair.a.lock().unwrap(),
            &mut pair.b.lock().unwrap(),
            &mut pair.seq,
        );
        SectionTransfer::index(&pair.b, &pair.destination, true);
        let b = pair.b.lock().unwrap();
        assert!(!module_exists(&b, &pair.source).unwrap());
        assert_eq!(reps(&b, "card"), 2);

        let log = review(&b, "card", 3, 3000);
        record_review(&b, "card", Some(log), None).unwrap();
        let mut a = pair.a.lock().unwrap();
        transfer(&b, &mut a, &mut pair.seq);
        assert_eq!(reps(&a, "card"), 3);
        assert_eq!(log_count(&a), 3);
    }

    #[test]
    fn images_are_queued_and_announced() {
        let (_a_dir, mut a) = db();
        let (b_dir, mut b) = db();
        let file = uuid::Uuid::new_v4().to_string();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');")
            .unwrap();
        a.execute(
            "insert into files values (?1, 'm', '/x', 'image/png')",
            [&file],
        )
        .unwrap();
        enable(&mut a, "{}").unwrap();
        assert_eq!(pending_uploads(&a).unwrap(), vec![file.clone()]);

        let later = uuid::Uuid::new_v4().to_string();
        a.execute(
            "insert into files values (?1, 'm', '/y', 'image/jpeg')",
            [&later],
        )
        .unwrap();
        assert!(record_file(&a, &later, "m", "image/jpeg").unwrap());
        assert_eq!(pending_uploads(&a).unwrap().len(), 2);

        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        let result = transfer(&a, &mut b, &mut seq);
        assert!(result.files_changed);
        let missing = missing_files(&b).unwrap();
        assert_eq!(missing.len(), 2);
        let stored =
            store_file(&b, &b_dir.join("files"), &later, "m", "image/jpeg", b"jpeg").unwrap();
        assert_eq!(std::fs::read(&stored.path).unwrap(), b"jpeg");
        assert_eq!(missing_files(&b).unwrap().len(), 1);
        // Downloaded images are not uploaded again.
        assert!(pending_uploads(&b).unwrap().is_empty());
    }

    #[test]
    fn server_gone_survives_reopen_and_stops_uploads_and_downloads() {
        let (dir, mut conn) = db();
        conn.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X''); insert into files values ('image', 'm', '/x', 'image/png');").unwrap();
        enable(&mut conn, "{}").unwrap();
        assert_eq!(pending_uploads(&conn).unwrap(), vec!["image"]);
        drop(conn);
        let db = crate::open_db(&dir).unwrap();
        let epoch = generation(&db.lock().unwrap()).unwrap();
        assert_eq!(
            sync_file_gone(&db, "image".into(), "stale".into()).unwrap_err(),
            STALE_GENERATION
        );
        sync_file_gone(&db, "image".into(), epoch).unwrap();
        drop(db);
        let mut conn = crate::open_db(&dir).unwrap().conn.into_inner().unwrap();
        assert!(file_gone(&conn, "image").unwrap());
        assert!(pending_uploads(&conn).unwrap().is_empty());
        // Retained backup rows remain readable, even when their server bytes are gone.
        assert_eq!(
            conn.query_row("select count(*) from files", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(string_entries(&load_vault(&conn).unwrap(), FILES_MAP)
            .iter()
            .any(|(id, record)| id == "image" && file_deleted(record)));
        assert_eq!(
            conn.query_row("select count(*) from sync_file_deletes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        disable(&conn).unwrap();
        enable(&mut conn, "{}").unwrap();
        assert!(!record_file(&conn, "image", "m", "image/png").unwrap());
        assert!(!publish_file_owners(&conn).unwrap());
        assert!(pending_uploads(&conn).unwrap().is_empty());
        conn.execute("delete from files", []).unwrap();
        // Even a stale live announcement cannot put this id back in the download queue.
        let doc = load_vault(&conn).unwrap();
        doc.get_or_insert_map(FILES_MAP).insert(
            &mut doc.transact_mut(),
            "image",
            file_record("m", "image/png"),
        );
        save_vault(&conn, &doc).unwrap();
        assert!(missing_files(&conn).unwrap().is_empty());
    }

    #[test]
    fn old_client_resurrection_is_retombstoned_on_server_gone() {
        let (_a_dir, mut a) = db();
        let (b_dir, mut b) = db();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X''); insert into files values ('image', 'm', '/x', 'image/png');").unwrap();
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        record_file_deleted(&a, "image").unwrap();
        transfer(&a, &mut b, &mut seq);
        assert!(missing_files(&b).unwrap().is_empty());
        // Released clients publish a live record over the tombstone.
        let doc = load_vault(&a).unwrap();
        let update = {
            let files = doc.get_or_insert_map(FILES_MAP);
            let mut txn = doc.transact_mut();
            files.insert(&mut txn, "image", file_record("m", "image/png"));
            txn.encode_update_v1()
        };
        save_vault(&a, &doc).unwrap();
        push_outbox(&a, VAULT_DOC, &update).unwrap();
        transfer(&a, &mut b, &mut seq);
        assert_eq!(missing_files(&b).unwrap().len(), 1);
        drop(b);
        let b = crate::open_db(&b_dir).unwrap();
        let epoch = generation(&b.lock().unwrap()).unwrap();
        sync_file_gone(&b, "image".into(), epoch).unwrap();
        let b = b.lock().unwrap();
        assert!(missing_files(&b).unwrap().is_empty());
        assert!(string_entries(&load_vault(&b).unwrap(), FILES_MAP)
            .iter()
            .any(|(id, record)| id == "image" && file_deleted(record)));
        transfer(&b, &mut a, &mut seq);
        assert!(string_entries(&load_vault(&a).unwrap(), FILES_MAP)
            .iter()
            .any(|(id, record)| id == "image" && file_deleted(record)));
        assert!(pending_deletes(&b).unwrap().is_empty());
    }

    #[test]
    fn cleanup_announces_a_tombstone_instead_of_downloading_again() {
        let (a_dir, mut a) = db();
        let (_b_dir, mut b) = db();
        let file = uuid::Uuid::new_v4().to_string();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'0000');").unwrap();
        a.execute(
            "insert into files values (?1, 'm', '/x', 'image/png')",
            [&file],
        )
        .unwrap();
        crate::files::assets::write(&a_dir, &file, b"image").unwrap();
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        drop(a);
        let a_db = crate::open_db(&a_dir).unwrap();
        assert_eq!(
            crate::files::cleanup_files(
                &a_dir,
                &a_db,
                "m".into(),
                vec![file.clone()],
                vec![0, 0],
                0
            )
            .unwrap(),
            vec![file.clone()]
        );
        let a = a_db.lock().unwrap();
        assert!(pending_deletes(&a).unwrap().is_empty());
        transfer(&a, &mut b, &mut seq);
        assert!(missing_files(&a).unwrap().is_empty());
        assert!(missing_files(&b).unwrap().is_empty());
        assert_eq!(pending_deletes(&a).unwrap(), vec![file]);
    }

    #[test]
    fn deleting_an_image_tombstones_it_before_server_deletion() {
        let (a_dir, mut a) = db();
        let (_b_dir, mut b) = db();
        let file = uuid::Uuid::new_v4().to_string();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');").unwrap();
        a.execute(
            "insert into files values (?1, 'm', '/x', 'image/png')",
            [&file],
        )
        .unwrap();
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        assert_eq!(missing_files(&b).unwrap().len(), 1);

        delete_module_data(&mut a, &a_dir.join("files"), "m").unwrap();
        assert!(pending_deletes(&a).unwrap().is_empty());
        assert!(pending_uploads(&a).unwrap().is_empty());
        seed(&a).unwrap();
        assert!(pending_deletes(&a).unwrap().is_empty());
        transfer(&a, &mut b, &mut seq);
        assert!(missing_files(&b).unwrap().is_empty());
        assert_eq!(pending_deletes(&a).unwrap(), vec![file.clone()]);
        drop(a);
        let a = crate::open_db(&a_dir).unwrap().conn.into_inner().unwrap();
        assert_eq!(pending_deletes(&a).unwrap(), vec![file.clone()]);
        assert!(!publish_file_owners(&a).unwrap());
        assert!(string_entries(&load_vault(&a).unwrap(), FILES_MAP)
            .iter()
            .any(|(id, record)| id == &file && file_deleted(record)));
    }

    #[test]
    fn remote_tombstones_keep_local_bytes_and_cannot_be_republished() {
        let (_a_dir, mut a) = db();
        let (b_dir, mut b) = db();
        let file = uuid::Uuid::new_v4().to_string();
        a.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');").unwrap();
        a.execute(
            "insert into files values (?1, 'm', '/x', 'image/png')",
            [&file],
        )
        .unwrap();
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();
        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        let stored =
            store_file(&b, &b_dir.join("files"), &file, "m", "image/png", b"image").unwrap();
        record_file_deleted(&a, &file).unwrap();
        transfer(&a, &mut b, &mut seq);
        assert_eq!(std::fs::read(stored.path).unwrap(), b"image");
        assert!(!publish_file_owners(&b).unwrap());
        assert!(!record_file(&b, &file, "m", "image/png").unwrap());
        seed(&b).unwrap();
        assert!(pending_uploads(&b).unwrap().is_empty());
        assert!(string_entries(&load_vault(&b).unwrap(), FILES_MAP)
            .iter()
            .any(|(id, record)| id == &file && file_deleted(record)));
        b.execute("delete from files where id = ?1", [&file])
            .unwrap();
        assert!(missing_files(&b).unwrap().is_empty());
    }

    #[test]
    fn a_shared_image_stays_downloadable_after_its_owner_is_deleted() {
        let (a_dir, mut a) = db();
        let (_b_dir, mut b) = db();
        a.execute_batch(
            "insert into modules (id, name) values ('owner', 'Owner'), ('other', 'Other');
             insert into contents values ('owner', X''), ('other', X'');",
        )
        .unwrap();
        let core = crate::Core::open(&a_dir).unwrap();
        let raw = crate::dispatch(
            &core,
            "save_file",
            &serde_json::json!({
                "moduleId":"owner", "bytes":[1,2,3], "mimeType":"image/png",
            })
            .to_string(),
        )
        .unwrap();
        let file = serde_json::from_str::<serde_json::Value>(&raw).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        // The other note references the image, as an occlusion card does.
        a.execute(
            "insert into shared_image_refs values ('other', ?1)",
            [&file],
        )
        .unwrap();
        enable(&mut a, "{}").unwrap();
        enable(&mut b, "{}").unwrap();

        record_module(&a, "owner", VaultChange::Deleted).unwrap();
        delete_module_data(&mut a, &a_dir.join("files"), "owner").unwrap();
        let owner: String = a
            .query_row("select module_id from files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owner, "other");
        assert_eq!(
            a.query_row("select count(*) from sync_file_deletes", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );

        let mut seq = 0;
        transfer(&a, &mut b, &mut seq);
        let missing = missing_files(&b).unwrap();
        assert_eq!(
            missing.len(),
            1,
            "the surviving note's image must be downloadable"
        );
        assert_eq!(missing[0].module_id, "other");
        // Nothing changed, so nothing more is published.
        assert!(!publish_file_owners(&a).unwrap());
    }

    #[test]
    fn deleting_a_module_drops_its_documents() {
        let (_dir, mut conn) = db();
        conn.execute_batch("insert into modules (id, name) values ('m', 'M'); insert into contents values ('m', X'');")
            .unwrap();
        enable(&mut conn, "{}").unwrap();
        conn.execute("delete from sync_outbox", []).unwrap();
        record_module(&conn, "m", VaultChange::Deleted).unwrap();
        let entries = outbox(&conn, i64::MAX).unwrap();
        let drops: Vec<&str> = entries
            .iter()
            .filter(|entry| entry.bytes.is_empty())
            .map(|entry| entry.doc.as_str())
            .collect();
        assert_eq!(drops, vec!["m", "r-m"]);
    }
}
