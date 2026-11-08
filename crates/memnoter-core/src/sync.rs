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

use crate::{db_err, delete_module_data, CommandResult, ContentUpdate, Db};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

pub const VAULT_DOC: &str = "vault";
const MODULES_MAP: &str = "modules";
const FILES_MAP: &str = "files";
const REVIEW_PREFIX: &str = "r-";

pub fn review_doc_id(module_id: &str) -> String {
    format!("{REVIEW_PREFIX}{module_id}")
}

// Card state and review log rows as JSON, for the review documents.
const CARD_STATE_JSON: &str = "json_object('due_at', due_at, 'stability', stability,
    'stability_fast', stability_fast, 'difficulty', difficulty, 'scheduled_days', scheduled_days,
    'learning_step', learning_step, 'reps', reps, 'lapses', lapses, 'state', state,
    'schedule_status', schedule_status, 'last_review_at', last_review_at, 'fsrs_model', fsrs_model)";
const LOG_JSON: &str =
    "json_object('card_id', card_id, 'rating', rating, 'review_time', review_time,
    'duration_ms', duration_ms, 'fsrs_model', fsrs_model, 'state', state,
    'schedule_status', schedule_status, 'due_at', due_at, 'last_review_at', last_review_at,
    'stability', stability, 'stability_fast', stability_fast, 'difficulty', difficulty,
    'scheduled_days', scheduled_days, 'learning_step', learning_step)";
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

fn push_outbox(conn: &Connection, doc: &str, bytes: &[u8]) -> CommandResult<()> {
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

// Records a local note change for upload, when sync is on.
pub fn record_update(conn: &Connection, module_id: &str, bytes: &[u8]) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    push_outbox(conn, module_id, bytes)?;
    Ok(true)
}

pub enum VaultChange<'a> {
    Name(&'a str),
    Deleted,
}

// Records a local module change in the vault, when sync is on.
pub fn record_module(
    conn: &Connection,
    module_id: &str,
    change: VaultChange,
) -> CommandResult<bool> {
    if !is_enabled(conn)? {
        return Ok(false);
    }
    let deleted = matches!(change, VaultChange::Deleted);
    let doc = load_vault(conn)?;
    let map = doc.get_or_insert_map(MODULES_MAP);
    let update = {
        let mut txn = doc.transact_mut();
        match change {
            VaultChange::Name(name) => {
                map.insert(&mut txn, format!("{module_id}.name"), name);
            }
            VaultChange::Deleted => {
                map.insert(&mut txn, format!("{module_id}.deleted"), true);
            }
        }
        txn.encode_update_v1()
    };
    save_vault(conn, &doc)?;
    push_outbox(conn, VAULT_DOC, &update)?;
    if deleted {
        forget_module_docs(conn, module_id)?;
    }
    Ok(true)
}

// The module was deleted: the server can forget its note and review history.
fn forget_module_docs(conn: &Connection, module_id: &str) -> CommandResult<()> {
    let reviews = review_doc_id(module_id);
    conn.execute("delete from sync_docs where doc = ?1", [&reviews])
        .map_err(db_err)?;
    push_outbox(conn, module_id, &[])?;
    push_outbox(conn, &reviews, &[])
}

// Records a new image for upload and tells other devices about it.
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
    record_file_deleted(conn, file_id)?;
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
    if !is_enabled(conn)? {
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
            &format!("select module_id, {CARD_STATE_JSON} from cards where id = ?1"),
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(db_err)?;
    let added = match added_log {
        Some(rowid) => Some(
            conn.query_row(
                &format!("select sync_id, {LOG_JSON} from review_log where id = ?1"),
                [rowid],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(db_err)?,
        ),
        None => None,
    };
    let doc_id = review_doc_id(&module_id);
    let doc = load_doc(conn, &doc_id)?;
    let cards = doc.get_or_insert_map("cards");
    let log = doc.get_or_insert_map("log");
    let update = {
        let mut txn = doc.transact_mut();
        cards.insert(&mut txn, card_id, state);
        if let Some((sync_id, row)) = added {
            log.insert(&mut txn, sync_id, row);
        }
        if let Some(sync_id) = removed_log {
            log.insert(&mut txn, sync_id, "");
        }
        txn.encode_update_v1()
    };
    save_doc(conn, &doc_id, &doc)?;
    push_outbox(conn, &doc_id, &update)?;
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
            _ => None,
        })
        .collect()
}

// Writes a review document into the card and review log tables. Cards and
// log rows this device does not have yet are skipped; this runs again after
// the note's cards are indexed.
fn apply_review_doc(conn: &Connection, doc: &Doc) -> CommandResult<bool> {
    let mut changed = false;
    for (card_id, state) in string_entries(doc, "cards") {
        changed |= conn
            .execute(
                "update cards set
                     due_at = json_extract(?2, '$.due_at'),
                     stability = json_extract(?2, '$.stability'),
                     stability_fast = json_extract(?2, '$.stability_fast'),
                     difficulty = json_extract(?2, '$.difficulty'),
                     scheduled_days = json_extract(?2, '$.scheduled_days'),
                     learning_step = json_extract(?2, '$.learning_step'),
                     reps = json_extract(?2, '$.reps'),
                     lapses = json_extract(?2, '$.lapses'),
                     state = json_extract(?2, '$.state'),
                     schedule_status = json_extract(?2, '$.schedule_status'),
                     last_review_at = json_extract(?2, '$.last_review_at'),
                     fsrs_model = json_extract(?2, '$.fsrs_model')
                 where id = ?1 and not (
                     reps = json_extract(?2, '$.reps')
                     and coalesce(last_review_at, -1) = coalesce(json_extract(?2, '$.last_review_at'), -1)
                 )",
                params![card_id, state],
            )
            .map_err(db_err)?
            > 0;
    }
    for (sync_id, row) in string_entries(doc, "log") {
        if row.is_empty() {
            conn.execute("delete from review_log where sync_id = ?1", [&sync_id])
                .map_err(db_err)?;
            continue;
        }
        conn.execute(
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
             where exists (select 1 from cards where id = json_extract(?2, '$.card_id'))",
            params![sync_id, row],
        )
        .map_err(db_err)?;
    }
    Ok(changed)
}

// After a note's cards were (re)indexed, gives new card rows their synced
// review state.
pub fn apply_reviews(conn: &Connection, module_id: &str) -> CommandResult<()> {
    if !is_enabled(conn)? {
        return Ok(());
    }
    let doc_id = review_doc_id(module_id);
    let exists = conn
        .query_row("select 1 from sync_docs where doc = ?1", [&doc_id], |_| {
            Ok(())
        })
        .optional()
        .map_err(db_err)?
        .is_some();
    if exists {
        apply_review_doc(conn, &load_doc(conn, &doc_id)?)?;
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

fn load_vault(conn: &Connection) -> CommandResult<Doc> {
    let doc = Doc::new();
    if let Some(state) = get_value::<Vec<u8>>(conn, "vault")? {
        let update = Update::decode_v1(&state).map_err(db_err)?;
        doc.transact_mut().apply_update(update).map_err(db_err)?;
    }
    Ok(doc)
}

fn save_vault(conn: &Connection, doc: &Doc) -> CommandResult<()> {
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    set_value(conn, "vault", state)
}

#[derive(Debug, Default, PartialEq)]
struct VaultModule {
    name: Option<String>,
    deleted: bool,
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
        let Some(name) = module.name else { continue };
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
    reconcile_documents(tx, doc)?;
    Ok((changed, deleted))
}

// Queues everything stored locally: the vault (with every module added) and
// each note's snapshot and saved updates.
fn seed(conn: &Connection) -> CommandResult<()> {
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
    let files: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare("select id, module_id, file_type from files where id not in (select file_id from sync_files_gone)")
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
            map.insert(&mut txn, id, record);
        }
    }
    conn.execute_batch("delete from sync_file_uploads; insert into sync_file_uploads (file_id) select id from files where id not in (select file_id from sync_files_gone);")
        .map_err(db_err)?;
    save_vault(conn, &doc)?;
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    push_outbox(conn, VAULT_DOC, &state)?;
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
    seed_reviews(conn, &modules)
}

// One review document per module that has reviewed cards or review history.
fn seed_reviews(conn: &Connection, modules: &[(String, String)]) -> CommandResult<()> {
    conn.execute_batch(
        "delete from sync_docs where doc like 'r-%';
         update review_log set sync_id = lower(hex(randomblob(16))) where sync_id is null;",
    )
    .map_err(db_err)?;
    for (module_id, _) in modules {
        let states: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "select id, {CARD_STATE_JSON} from cards
                     where module_id = ?1 and (reps > 0 or last_review_at is not null)"
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map([module_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        let logs: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(&format!(
                    "select sync_id, {LOG_JSON} from review_log
                     where card_id in (select id from cards where module_id = ?1) order by id"
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map([module_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        if states.is_empty() && logs.is_empty() {
            continue;
        }
        let doc_id = review_doc_id(module_id);
        let doc = Doc::new();
        let cards = doc.get_or_insert_map("cards");
        let log = doc.get_or_insert_map("log");
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
        push_outbox(conn, &doc_id, &state)?;
    }
    Ok(())
}

fn delete_modules(conn: &mut Connection, files_dir: &Path, ids: &[String]) -> CommandResult<()> {
    let data_dir = files_dir.parent().ok_or("Invalid files directory")?;
    for id in deleted_documents(&load_vault(conn)?) {
        crate::documents::remove_local(data_dir, conn, &id)?;
    }
    for id in ids {
        delete_module_data(conn, files_dir, id)?;
        conn.execute("delete from sync_docs where doc = ?1", [review_doc_id(id)])
            .map_err(db_err)?;
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
    #[allow(dead_code)]
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
    // Images this device does not have yet are known.
    files_changed: bool,
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
    rotate_generation(&tx)?;
    tx.commit().map_err(db_err)
}

fn disable(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "delete from sync_outbox; delete from sync_state; delete from sync_docs; delete from sync_file_uploads; delete from sync_file_deletes;",
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

    // The vault first, so modules exist before their content is stored.
    let (vault_entries, rest): (Vec<_>, Vec<_>) = entries
        .into_iter()
        .partition(|entry| entry.doc == VAULT_DOC);
    let (review_entries, content_entries): (Vec<_>, Vec<_>) = rest
        .into_iter()
        .partition(|entry| entry.doc.starts_with(REVIEW_PREFIX));
    let doc = load_vault(&tx)?;
    if !vault_entries.is_empty() {
        {
            let mut txn = doc.transact_mut();
            for entry in &vault_entries {
                let update = Update::decode_v1(&entry.bytes).map_err(db_err)?;
                txn.apply_update(update).map_err(db_err)?;
            }
        }
        // Remote file tombstones leave local bytes intact: note/card references
        // and undo leases remain authoritative. Normal cleanup reclaims them.
        save_vault(&tx, &doc)?;
    }
    let (changed, deleted) = reconcile(&tx, &doc)?;
    result.modules_changed = changed;
    result.deleted = deleted;
    let vault = vault_modules(&doc);

    let now = chrono::Utc::now().timestamp_millis();
    let mut touched = HashSet::new();
    for entry in content_entries {
        if vault.get(&entry.doc).is_some_and(|module| module.deleted) {
            continue;
        }
        if !module_exists(&tx, &entry.doc)? {
            // Content can arrive before the vault entry that names it, for
            // example after the vault was compacted. The name follows later.
            crate::content::module_rows::insert(&tx, &entry.doc, "Untitled", &[])?;
            result.modules_changed = true;
        }
        tx.execute(
            "insert into contents_updates (module_id, bytes, created_at) values (?1, ?2, ?3)",
            params![entry.doc, entry.bytes, now],
        )
        .map_err(db_err)?;
        result.updates.push(RemoteUpdate {
            module_id: entry.doc.clone(),
            update: ContentUpdate {
                id: tx.last_insert_rowid(),
                bytes: entry.bytes,
            },
        });
        touched.insert(entry.doc);
    }
    let mut reviews: BTreeMap<String, Vec<RemoteEntry>> = BTreeMap::new();
    for entry in review_entries {
        reviews.entry(entry.doc.clone()).or_default().push(entry);
    }
    for (doc_id, entries) in reviews {
        let module_id = &doc_id[REVIEW_PREFIX.len()..];
        if vault.get(module_id).is_some_and(|module| module.deleted) {
            continue;
        }
        let doc = load_doc(&tx, &doc_id)?;
        {
            let mut txn = doc.transact_mut();
            for entry in &entries {
                txn.apply_update(Update::decode_v1(&entry.bytes).map_err(db_err)?)
                    .map_err(db_err)?;
            }
        }
        save_doc(&tx, &doc_id, &doc)?;
        result.reviews_changed |= apply_review_doc(&tx, &doc)?;
    }
    result.files_changed = !vault_entries.is_empty() && !missing_files(&tx)?.is_empty();

    // The search and card indexes are rebuilt from the note text.
    for module_id in &touched {
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
    if doc_id.starts_with(REVIEW_PREFIX) {
        return conn
            .query_row(
                "select state from sync_docs where doc = ?1",
                [doc_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err);
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
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&record) else {
            continue;
        };
        if record["deleted"] == true {
            continue;
        }
        let (Some(module_id), Some(file_type)) =
            (record["module"].as_str(), record["type"].as_str())
        else {
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
    conn.execute(
        "insert or ignore into files (id, module_id, path, file_type) values (?1, ?2, ?3, ?4)",
        params![file_id, module_id, path_str, file_type],
    )
    .map_err(db_err)?;
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
    let tx = conn.transaction().map_err(db_err)?;
    let doc = load_vault(&tx)?;
    let (modules_changed, deleted) = reconcile(&tx, &doc)?;
    tx.commit().map_err(db_err)?;
    delete_modules(&mut conn, &data_dir.join("files"), &deleted)?;
    Ok(ApplyResult {
        modules_changed,
        deleted,
        ..ApplyResult::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text};

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
        let file = uuid::Uuid::new_v4().to_string();
        a.execute_batch(
            "insert into modules (id, name) values ('owner', 'Owner'), ('other', 'Other');
             insert into contents values ('owner', X''), ('other', X'');",
        )
        .unwrap();
        a.execute(
            "insert into files values (?1, 'owner', ?2, 'image/png')",
            params![file, "/x"],
        )
        .unwrap();
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
