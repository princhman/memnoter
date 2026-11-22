use crate::{db_err, sync, CommandResult, ContentUpdate, Db};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

mod assets;
mod conflict;
use conflict::{copy_conflicting_chapter, SectionConflict};

// The worker must still serve released protocol-2 clients. Once a transfer
// is published, skipping its cut and seeing later edits is unsafe.
const TRANSFER_PROTOCOL: u64 = 3;

pub(crate) fn published_transfers_supported() -> bool {
    configured_protocol_floor() >= TRANSFER_PROTOCOL
}

fn configured_protocol_floor() -> u64 {
    sync::session::contract()["oldestVersion"]
        .as_u64()
        .unwrap_or_default()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionEdit {
    module_id: String,
    expected_state: Vec<u8>,
    expected_update_id: i64,
    bytes: Vec<u8>,
}

// A section transfer commits both Yjs edits, image leases and card ownership
// together. Revision checks reject a concurrent edit instead of deleting stale
// content; no half-move is published if validation or persistence fails.
pub fn move_section(
    db: &Db,
    edits: Vec<SectionEdit>,
    card_ids: Vec<String>,
    heading_ids: Vec<String>,
    restore_source: Option<Vec<u8>>,
) -> CommandResult<Vec<ContentUpdate>> {
    move_section_at_protocol(
        db,
        edits,
        card_ids,
        heading_ids,
        restore_source,
        configured_protocol_floor(),
    )
}

pub(crate) fn move_section_at_protocol(
    db: &Db,
    mut edits: Vec<SectionEdit>,
    card_ids: Vec<String>,
    heading_ids: Vec<String>,
    restore_source: Option<Vec<u8>>,
    oldest_protocol: u64,
) -> CommandResult<Vec<ContentUpdate>> {
    if edits.is_empty()
        || edits.len() > 2
        || (edits.len() == 2 && edits[0].module_id == edits[1].module_id)
    {
        return Err("Invalid section move".into());
    }
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let synced = sync::is_enabled(&tx)?;
    if edits.len() == 2 && synced && oldest_protocol < TRANSFER_PROTOCOL {
        return Err("Moving a chapter between synced notes requires a newer sync service.".into());
    }
    if edits.len() == 2 && !synced {
        for edit in &edits {
            if was_synced(&tx, &edit.module_id)? {
                return Err(
                    "These notes have synced before. A cross-note move requires compatible sync."
                        .into(),
                );
            }
        }
    }
    let transfer_heading = (edits.len() == 2 && synced)
        .then(|| heading_ids.first().ok_or("Missing chapter heading"))
        .transpose()?;
    let mut asset_copies = assets::Copies::default();
    let mut receipts = Vec::new();
    for (index, edit) in edits.iter_mut().enumerate() {
        let (state, latest): (Vec<u8>, i64) = tx.query_row(
            "select state, coalesce((select max(id) from contents_updates where module_id=?1),0)
             from contents where module_id=?1",
            [&edit.module_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(db_err)?;
        if state != edit.expected_state || latest != edit.expected_update_id {
            return Err("A note changed during the move. Please drag the section again.".into());
        }
        let doc = crate::worksheets::load(&tx, &edit.module_id)?;
        let before = crate::worksheets::read(&doc)?;
        let admitted = crate::worksheets::admitted_assets(&doc);
        doc.transact_mut()
            .apply_update(Update::decode_v1(&edit.bytes).map_err(db_err)?)
            .map_err(db_err)?;
        if let Some(heading) = transfer_heading.filter(|_| index == 1) {
            let remap =
                asset_copies.copy_into(&tx, &db.data_dir, &edit.module_id, &doc, heading)?;
            edit.bytes = combine(&edit.bytes, &remap)?;
        }
        crate::worksheets::admit(&tx, &edit.module_id, before, &admitted, &doc)?;
        crate::asset_refs::retain_module(&tx, &edit.module_id)?;
        tx.execute(
            "insert into contents_updates(module_id,bytes,created_at) values (?1,?2,?3)",
            params![edit.module_id, edit.bytes, Utc::now().timestamp_millis()],
        )
        .map_err(db_err)?;
        receipts.push(ContentUpdate {
            id: tx.last_insert_rowid(),
            bytes: edit.bytes.clone(),
        });
        crate::asset_refs::retain_module(&tx, &edit.module_id)?;
        crate::search::invalidate_indexes(&tx, &edit.module_id)?;
    }
    match edits.as_slice() {
        [edit] => {
            sync::record_update(&tx, &edit.module_id, &edit.bytes)?;
        }
        [source, destination] if synced => {
            let heading = transfer_heading.ok_or("Missing chapter heading")?;
            let restore = restore_source.ok_or("Missing section recovery update")?;
            let source_doc = crate::worksheets::load(&tx, &source.module_id)?;
            let before = crate::worksheets::read(&source_doc)?;
            source_doc
                .transact_mut()
                .apply_update(Update::decode_v1(&restore).map_err(db_err)?)
                .map_err(db_err)?;
            if crate::worksheets::read(&source_doc)? != before {
                return Err("A section recovery cannot modify worksheet history".into());
            }
            let remap = asset_copies.rewrite_recovery(&source_doc, heading)?;
            record(
                &tx,
                source,
                destination,
                card_ids,
                heading_ids,
                combine(&restore, &remap)?,
            )?;
        }
        [source, destination] => {
            remember_headings(&tx, &source.module_id, &destination.module_id, &heading_ids)?;
            for card_id in card_ids {
                tx.execute(
                    "update cards set module_id=?1 where id=?2 and module_id=?3",
                    params![destination.module_id, card_id, source.module_id],
                )
                .map_err(db_err)?;
            }
        }
        _ => unreachable!(),
    }
    tx.commit().map_err(db_err)?;
    asset_copies.committed();
    Ok(receipts)
}

fn combine(first: &[u8], second: &[u8]) -> CommandResult<Vec<u8>> {
    yrs::merge_updates_v1([first, second]).map_err(db_err)
}

// Older receivers treat these Yjs documents as review docs with no reviews.
// Each document is immutable and carries both note updates in one wire entry.
pub(crate) const SYNC_PREFIX: &str = "r-move-";
const MOVE_MAP: &str = "sectionMove";

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct ReviewRoute {
    pub(crate) review_module: String,
    // Oldest owner first. A review or undo in a newer epoch supersedes the
    // schedule in earlier epochs, while all epochs share the same log and
    // undo tombstones.
    pub(crate) epochs: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Move {
    source: String,
    destination: String,
    cards: Vec<(String, ReviewRoute)>,
    #[serde(default)]
    headings: Vec<String>,
}

pub(crate) fn migrate(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "create table if not exists sync_section_moves (
            doc TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL, state BLOB NOT NULL
         );
         create table if not exists sync_card_locations (
            card_id TEXT PRIMARY KEY, module_id TEXT NOT NULL,
            review_module TEXT NOT NULL, epochs TEXT NOT NULL
         );
         create index if not exists sync_card_locations_review on sync_card_locations(review_module);
         create index if not exists sync_card_locations_module on sync_card_locations(module_id);",
    )
    .map_err(db_err)
}

pub(crate) fn migrate_recovery(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "create table if not exists section_redirects (
            source TEXT NOT NULL, heading TEXT NOT NULL, destination TEXT NOT NULL,
            PRIMARY KEY(source, heading, destination)
         );
         create table if not exists recovered_section_moves (doc TEXT PRIMARY KEY);
         create table if not exists pending_section_moves (
            doc TEXT PRIMARY KEY, state BLOB NOT NULL,
            conflict_note TEXT, conflict_content BLOB, conflict_cut BLOB
         );
         create table if not exists pending_section_cards (
            doc TEXT NOT NULL REFERENCES pending_section_moves(doc) ON DELETE CASCADE,
            card_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
            PRIMARY KEY(doc,card_id)
         );
         create index if not exists pending_section_cards_owner on pending_section_cards(destination,card_id);
         create table if not exists retired_section_moves (doc TEXT PRIMARY KEY);
         create table if not exists section_conflict_notes (module_id TEXT PRIMARY KEY);
         create table if not exists section_synced_notes (module_id TEXT PRIMARY KEY);
         insert or ignore into section_synced_notes(module_id)
             select id from modules where exists(select 1 from sync_state where key='account');
         insert or ignore into pending_section_moves(doc,state)
             select doc,state from sync_docs where doc like 'r-move-%';
         delete from sync_docs where doc like 'r-move-%';",
    )
    .map_err(db_err)
}

fn was_synced(conn: &Connection, module: &str) -> CommandResult<bool> {
    conn.query_row(
        "select exists(select 1 from section_synced_notes where module_id=?1)",
        [module],
        |row| row.get(0),
    )
    .map_err(db_err)
}

pub(crate) fn remember_synced_note(conn: &Connection, module: &str) -> CommandResult<()> {
    conn.execute(
        "insert or ignore into section_synced_notes(module_id) values (?1)",
        [module],
    )
    .map_err(db_err)?;
    Ok(())
}

pub(crate) fn stage(conn: &Connection, id: &str, bytes: &[u8]) -> CommandResult<()> {
    conn.execute(
        "insert or ignore into pending_section_moves(doc,state) values (?1,?2)",
        params![id, bytes],
    )
    .map_err(db_err)?;
    Ok(())
}

fn reserve_cards(conn: &Connection, id: &str, movement: &Move) -> CommandResult<()> {
    for (card, _) in &movement.cards {
        conn.execute(
            "insert or ignore into pending_section_cards(doc,card_id,source,destination)
             values (?1,?2,?3,?4)",
            params![id, card, movement.source, movement.destination],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub(crate) fn review_route(conn: &Connection, card_id: &str) -> CommandResult<Option<ReviewRoute>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "select review_module, epochs from sync_card_locations where card_id=?1",
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_err)?;
    row.map(|(review_module, epochs)| {
        Ok(ReviewRoute {
            review_module,
            epochs: serde_json::from_str(&epochs).map_err(db_err)?,
        })
    })
    .transpose()
}

fn record(
    conn: &Connection,
    source: &SectionEdit,
    destination: &SectionEdit,
    card_ids: Vec<String>,
    headings: Vec<String>,
    restore_source: Vec<u8>,
) -> CommandResult<()> {
    let id = format!("{SYNC_PREFIX}{}", uuid::Uuid::new_v4());
    let mut cards = Vec::new();
    for card_id in card_ids {
        let foreign_owner: bool = conn
            .query_row(
                "select exists(select 1 from cards where id=?1 and module_id<>?2)
                 or exists(select 1 from sync_card_locations where card_id=?1 and module_id<>?2)",
                params![card_id, source.module_id],
                |row| row.get(0),
            )
            .map_err(db_err)?;
        if foreign_owner {
            continue;
        }
        let mut route = review_route(conn, &card_id)?.unwrap_or_else(|| ReviewRoute {
            review_module: source.module_id.clone(),
            epochs: vec![],
        });
        route.epochs.push(id.clone());
        cards.push((card_id, route));
    }
    let movement = Move {
        source: source.module_id.clone(),
        destination: destination.module_id.clone(),
        cards,
        headings,
    };
    let doc = Doc::new();
    let map = doc.get_or_insert_map(MOVE_MAP);
    {
        let mut txn = doc.transact_mut();
        map.insert(
            &mut txn,
            "move",
            serde_json::to_string(&movement).map_err(db_err)?,
        );
        map.insert(
            &mut txn,
            "restoreSource",
            Any::from(restore_source.as_slice()),
        );
        map.insert(&mut txn, "source", Any::from(source.bytes.as_slice()));
        map.insert(
            &mut txn,
            "destination",
            Any::from(destination.bytes.as_slice()),
        );
    }
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    remember(conn, &id, &bytes, &movement)?;
    relocate_cards(conn)?;
    if sync::is_enabled(conn)? {
        let review_modules: std::collections::BTreeSet<_> = movement
            .cards
            .iter()
            .map(|(_, route)| &route.review_module)
            .collect();
        for module in review_modules {
            sync::carry_reviews(conn, module)?;
        }
        sync::push_outbox(conn, &id, &bytes)?;
    }
    Ok(())
}

fn remember(conn: &Connection, id: &str, bytes: &[u8], movement: &Move) -> CommandResult<()> {
    conn.execute(
        "insert into sync_section_moves(doc,source,destination,state) values (?1,?2,?3,?4)",
        params![id, movement.source, movement.destination, bytes],
    )
    .map_err(db_err)?;
    remember_headings(
        conn,
        &movement.source,
        &movement.destination,
        &movement.headings,
    )?;
    for (card_id, route) in &movement.cards {
        let current = review_route(conn, card_id)?;
        // A delayed ancestor must not claim a card that has since moved.
        // For concurrent branches, the first differing epoch breaks the tie.
        if current.is_some_and(|current| current.epochs >= route.epochs) {
            continue;
        }
        conn.execute(
            "insert into sync_card_locations(card_id,module_id,review_module,epochs) values (?1,?2,?3,?4)
             on conflict(card_id) do update set module_id=excluded.module_id,
                review_module=excluded.review_module, epochs=excluded.epochs",
            params![card_id, movement.destination, route.review_module,
                serde_json::to_string(&route.epochs).map_err(db_err)?],
        ).map_err(db_err)?;
    }
    Ok(())
}

fn remember_headings(
    conn: &Connection,
    source: &str,
    destination: &str,
    headings: &[String],
) -> CommandResult<()> {
    for heading in headings {
        conn.execute(
            "insert or ignore into section_redirects(source,heading,destination) values (?1,?2,?3)",
            params![source, heading, destination],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub fn heading_destinations(
    db: &Db,
    module: String,
    heading: String,
) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(
            "with recursive destinations(module) as (
                 select destination from section_redirects where source=?1 and heading=?2
                 union
                 select r.destination from section_redirects r join destinations d on r.source=d.module
                 where r.heading=?2
             ) select module from destinations where module<>?1 order by module",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![module, heading], |row| row.get(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

// New replicas can learn of a move before receiving the destination's name.
pub(crate) fn relocate_cards(conn: &Connection) -> CommandResult<()> {
    conn.execute(
        "update cards set module_id=location.module_id, deleted_at=null from sync_card_locations location
         where cards.id=location.card_id and cards.module_id<>location.module_id
           and exists(select 1 from modules where id=location.module_id)",
        [],
    )
    .map_err(db_err)?;
    Ok(())
}

pub(crate) struct RemoteMove {
    pub(crate) edits: [(String, Vec<u8>); 2],
    pub(crate) review_modules: Vec<String>,
    pub(crate) conflict: Option<SectionConflict>,
}

/// Apply the same source insertion on every replica when the destination is
/// deleted. The producer assigned the Yjs item IDs once, so replay is safe.
pub(crate) fn recover(conn: &Connection, id: &str) -> CommandResult<Option<(String, Vec<u8>)>> {
    if conn
        .execute(
            "insert or ignore into recovered_section_moves(doc) values (?1)",
            [id],
        )
        .map_err(db_err)?
        == 0
    {
        return Ok(None);
    }
    let bytes: Vec<u8> = conn
        .query_row(
            "select state from sync_section_moves where doc=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let (movement, _, _, restore) = decode(&bytes)?;
    let Some(restore) = restore else {
        return Ok(None);
    };
    for (card_id, route) in movement.cards {
        conn.execute(
            "update sync_card_locations set module_id=?1
             where card_id=?2 and module_id=?3 and epochs=?4",
            params![
                movement.source,
                card_id,
                movement.destination,
                serde_json::to_string(&route.epochs).map_err(db_err)?
            ],
        )
        .map_err(db_err)?;
    }
    Ok(Some((movement.source, restore)))
}

pub(crate) fn receive(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
    is_deleted: impl Fn(&str) -> bool,
) -> CommandResult<Option<RemoteMove>> {
    if conn
        .query_row(
            "select exists(select 1 from sync_section_moves where doc=?1)
              or exists(select 1 from retired_section_moves where doc=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_err)?
    {
        conn.execute("delete from pending_section_moves where doc=?1", [id])
            .map_err(db_err)?;
        return Ok(None);
    }
    let (movement, source, destination, _) = decode(bytes)?;
    let invalid = || "Invalid synced section move".to_string();
    if movement.source == movement.destination
        || movement
            .cards
            .iter()
            .any(|(_, route)| route.epochs.last().map(String::as_str) != Some(id))
    {
        return Err(invalid());
    }
    if is_deleted(&movement.source) && is_deleted(&movement.destination) {
        retire(conn, id)?;
        return Ok(None);
    }
    let source_deleted = is_deleted(&movement.source);
    let source_ready = source_deleted || can_apply(conn, &movement.source, &source)?;
    if source_ready && !source_deleted {
        // Save the local variant before an ordinary source snapshot that
        // contains the cut can arrive while the destination is still pending.
        if let Some(conflict) = copy_conflicting_chapter(conn, id, &movement, &source)? {
            conn.execute(
                "update pending_section_moves set conflict_note=?1, conflict_content=?2,
                 conflict_cut=?3 where doc=?4",
                params![
                    conflict.module_id,
                    conflict.content,
                    conflict.source_cut,
                    id
                ],
            )
            .map_err(db_err)?;
        }
    }
    if !source_ready
        || (!is_deleted(&movement.destination)
            && !can_apply(conn, &movement.destination, &destination)?)
    {
        reserve_cards(conn, id, &movement)?;
        return Ok(None);
    }
    let conflict = if source_deleted {
        None
    } else {
        conn.query_row(
            "select conflict_note,conflict_content,conflict_cut from pending_section_moves
             where doc=?1 and conflict_note is not null",
            [id],
            |r| {
                Ok(SectionConflict {
                    module_id: r.get(0)?,
                    content: r.get(1)?,
                    source_cut: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(db_err)?
    };
    remember(conn, id, bytes, &movement)?;
    conn.execute("delete from pending_section_moves where doc=?1", [id])
        .map_err(db_err)?;
    Ok(Some(RemoteMove {
        edits: [
            (movement.source, source),
            (movement.destination, destination),
        ],
        review_modules: movement
            .cards
            .into_iter()
            .map(|(_, route)| route.review_module)
            .collect(),
        conflict,
    }))
}

pub(crate) fn retire(conn: &Connection, id: &str) -> CommandResult<()> {
    if conn
        .execute(
            "insert or ignore into retired_section_moves(doc) values (?1)",
            [id],
        )
        .map_err(db_err)?
        == 0
    {
        return Ok(());
    }
    for table in [
        "pending_section_moves",
        "sync_section_moves",
        "recovered_section_moves",
    ] {
        conn.execute(&format!("delete from {table} where doc=?1"), [id])
            .map_err(db_err)?;
    }
    conn.execute("delete from sync_outbox where doc=?1", [id])
        .map_err(db_err)?;
    sync::push_outbox(conn, id, &[])
}

fn can_apply(conn: &Connection, module: &str, bytes: &[u8]) -> CommandResult<bool> {
    let exists: bool = conn
        .query_row(
            "select exists(select 1 from contents where module_id=?1)",
            [module],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let doc = if exists {
        crate::worksheets::load(conn, module)?
    } else {
        Doc::new()
    };
    let update = Update::decode_v1(bytes).map_err(db_err)?;
    let deletions = update.delete_set().clone();
    doc.transact_mut().apply_update(update).map_err(db_err)?;
    let txn = doc.transact();
    let known = txn.state_vector();
    Ok(!txn.has_missing_updates()
        && deletions
            .iter()
            .all(|(client, ranges)| ranges.iter().all(|range| range.end <= known.get(client))))
}

fn decode(bytes: &[u8]) -> CommandResult<(Move, Vec<u8>, Vec<u8>, Option<Vec<u8>>)> {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(bytes).map_err(db_err)?)
        .map_err(db_err)?;
    let txn = doc.transact();
    let invalid = || "Invalid synced section move".to_string();
    let map = txn.get_map(MOVE_MAP).ok_or_else(invalid)?;
    let Some(Out::Any(Any::String(metadata))) = map.get(&txn, "move") else {
        return Err(invalid());
    };
    let movement: Move = serde_json::from_str(&metadata).map_err(db_err)?;
    let edit = |key| match map.get(&txn, key) {
        Some(Out::Any(Any::Buffer(bytes))) => Ok(Some(bytes.to_vec())),
        None => Ok(None),
        _ => Err(invalid()),
    };
    Ok((
        movement,
        edit("source")?.ok_or_else(invalid)?,
        edit("destination")?.ok_or_else(invalid)?,
        edit("restoreSource")?,
    ))
}
