use crate::{db_err, sync, CommandResult, ContentUpdate, Db};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

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
) -> CommandResult<Vec<ContentUpdate>> {
    if edits.is_empty()
        || edits.len() > 2
        || (edits.len() == 2 && edits[0].module_id == edits[1].module_id)
    {
        return Err("Invalid section move".into());
    }
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let mut receipts = Vec::new();
    for edit in &edits {
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
        [source, destination] => record(&tx, source, destination, card_ids)?,
        _ => unreachable!(),
    }
    tx.commit().map_err(db_err)?;
    Ok(receipts)
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

// New replicas can learn of a move before receiving the destination's name.
pub(crate) fn relocate_cards(conn: &Connection) -> CommandResult<()> {
    conn.execute(
        "update cards set module_id=location.module_id from sync_card_locations location
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
}

pub(crate) fn receive(
    conn: &Connection,
    id: &str,
    bytes: &[u8],
) -> CommandResult<Option<RemoteMove>> {
    if conn
        .query_row(
            "select exists(select 1 from sync_section_moves where doc=?1)",
            [id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_err)?
    {
        return Ok(None);
    }
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
        Some(Out::Any(Any::Buffer(bytes))) => Ok(bytes.to_vec()),
        _ => Err(invalid()),
    };
    let source = edit("source")?;
    let destination = edit("destination")?;
    if movement.source == movement.destination
        || movement
            .cards
            .iter()
            .any(|(_, route)| route.epochs.last().map(String::as_str) != Some(id))
    {
        return Err(invalid());
    }
    remember(conn, id, bytes, &movement)?;
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
    }))
}
