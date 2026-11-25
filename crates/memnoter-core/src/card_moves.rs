//! Moves a card's schedule and review history to a new card id.
//!
//! Each move is its own Yjs document, synced as "r-lineage-<op>". Released
//! apps store it without reading it: it has no "cards" or "log" rows of the
//! kind they apply. Schedule and log are computed from the merged set of
//! moves, so the order in which devices receive them does not matter.
//!
//! Moves only go forward, to ids that were never used. The newest card of a
//! chain that is live in the text holds the history, so undoing a paste and
//! its cut gives it back without another move.
//!
//! Maps: "move" holds the immutable description, "carried" the review rows
//! known when the card moved (and late ones of the old id), "own" the rows
//! made after the move, "state" the schedule after those, "pred" late
//! schedule of the old id, and "gone" the undone rows.
use crate::sync::{
    card_state_json, is_enabled, load_doc, log_json, push_outbox, review_doc_id, string_entries,
};
use crate::{db_err, CommandResult, Db};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};
use yrs::{updates::decoder::Decode, Doc, Map, ReadTxn, StateVector, Transact, Update};

pub(crate) const PREFIX: &str = "r-lineage-";

pub(crate) fn migrate(conn: &Connection) -> CommandResult<()> {
    // Kept while sync is off: turning it on again publishes these.
    conn.execute_batch(
        "create table if not exists card_moves (op TEXT PRIMARY KEY, doc BLOB NOT NULL);
         create table if not exists card_move_ends (card_id TEXT NOT NULL, op TEXT NOT NULL, module_id TEXT NOT NULL, PRIMARY KEY(card_id, op));
         create index if not exists card_move_ends_module on card_move_ends(module_id);
         -- Notes whose text changed after their cards were last indexed.
         create table if not exists card_stale_modules (module_id TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE, update_id INTEGER NOT NULL);
         create trigger if not exists card_stale_on_update after insert on contents_updates begin
             insert or replace into card_stale_modules (module_id, update_id) values (new.module_id, new.id);
         end;",
    )
    .map_err(db_err)?;
    // An older app stored the moves it received without reading them.
    let stored: Vec<(String, Vec<u8>)> = {
        let mut stmt = conn
            .prepare("select substr(doc, length(?1) + 1), state from sync_docs where substr(doc, 1, length(?1)) = ?1")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([PREFIX], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    let mut cards = BTreeSet::new();
    for (op, state) in stored {
        cards.extend(receive(conn, &op, &[state])?);
    }
    for card in &cards {
        fold(conn, card)?;
    }
    materialize(conn, cards)?;
    conn.execute(
        "delete from sync_docs where substr(doc, 1, length(?1)) = ?1",
        [PREFIX],
    )
    .map(|_| ())
    .map_err(db_err)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Meta {
    from: String,
    from_module: String,
    to: String,
    to_module: String,
    // When it happened, to settle competing moves.
    at: i64,
    state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transfer {
    Moved,
    // Nothing is written for these; the paste becomes a new card.
    SourceMissing,
    DestinationTaken,
}

struct Node {
    meta: Meta,
    doc: Doc,
}

fn entries(doc: &Doc, map: &str) -> BTreeMap<String, String> {
    string_entries(doc, map).into_iter().collect()
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn read(conn: &Connection, op: &str) -> CommandResult<Doc> {
    let doc = Doc::new();
    let state: Option<Vec<u8>> = conn
        .query_row("select doc from card_moves where op = ?1", [op], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    if let Some(state) = state {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).map_err(db_err)?)
            .map_err(db_err)?;
    }
    Ok(doc)
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct Schedule {
    due_at: i64,
    stability: f64,
    stability_fast: f64,
    difficulty: f64,
    scheduled_days: f64,
    learning_step: i64,
    state: i64,
    schedule_status: String,
    last_review_at: Option<i64>,
    reps: i64,
    lapses: i64,
    fsrs_model: Option<String>,
}

// Synced data is written to strict columns, where one bad value would fail
// every later sync.
fn valid_state(state: &str) -> bool {
    serde_json::from_str::<Schedule>(state).is_ok()
}

fn state_of(doc: &Doc, map: &str, key: &str) -> Option<String> {
    entries(doc, map)
        .remove(key)
        .filter(|state| valid_state(state))
}

fn reviewed_at(state: &str) -> i64 {
    serde_json::from_str::<Schedule>(state)
        .ok()
        .and_then(|state| state.last_review_at)
        .unwrap_or(-1)
}

// The schedule along a path as of its `last` move. Reviews after that move
// decide; before any, the latest of what was moved, what came late for the card
// it moved, and reviews of that card while another move of it was undone.
fn schedule(
    nodes: &BTreeMap<String, Node>,
    path: &[String],
    undone: &BTreeSet<i64>,
) -> Option<String> {
    let (op, earlier) = path.split_last()?;
    let node = &nodes[op];
    if let Some(state) = state_of(&node.doc, "state", "state") {
        return Some(state);
    }
    let mut states: Vec<String> = entries(&node.doc, "pred").into_values().collect();
    states.push(node.meta.state.clone());
    states.extend(schedule(nodes, earlier, undone));
    for (other, sibling) in nodes {
        if other != op && sibling.meta.from == node.meta.from {
            states.extend(state_of(&sibling.doc, "state", &node.meta.from));
        }
    }
    states.retain(|state| valid_state(state) && !undone.contains(&reviewed_at(state)));
    states
        .into_iter()
        .max_by_key(|state| (reviewed_at(state), state.clone()))
        .or_else(|| Some(node.meta.state.clone()))
}

fn meta_of(doc: &Doc) -> Option<Meta> {
    let meta: Meta = serde_json::from_str(entries(doc, "move").get("meta")?).ok()?;
    valid_state(&meta.state).then_some(meta)
}

fn store(conn: &Connection, op: &str, doc: &Doc) -> CommandResult<()> {
    conn.execute(
        "insert into card_moves (op, doc) values (?1, ?2) on conflict(op) do update set doc = excluded.doc",
        params![op, encode(doc)],
    )
    .map_err(db_err)?;
    if let Some(meta) = meta_of(doc) {
        for (card, module) in [(&meta.from, &meta.from_module), (&meta.to, &meta.to_module)] {
            conn.execute(
                "insert or ignore into card_move_ends (card_id, op, module_id) values (?1, ?2, ?3)",
                params![card, op, module],
            )
            .map_err(db_err)?;
        }
    }
    Ok(())
}

// Writes (map, key, value) rows this document does not already hold.
fn write(conn: &Connection, op: &str, doc: &Doc, rows: &[(&str, &str, &str)]) -> CommandResult<()> {
    let rows: Vec<_> = rows
        .iter()
        .filter(|(map, key, value)| entries(doc, map).get(*key).map(String::as_str) != Some(*value))
        .collect();
    if rows.is_empty() {
        return Ok(());
    }
    let maps: Vec<_> = rows.iter().map(|row| doc.get_or_insert_map(row.0)).collect();
    let update = {
        let mut txn = doc.transact_mut();
        for (map, (_, key, value)) in maps.iter().zip(&rows) {
            map.insert(&mut txn, *key, *value);
        }
        txn.encode_update_v1()
    };
    store(conn, op, doc)?;
    if is_enabled(conn)? {
        push_outbox(conn, &format!("{PREFIX}{op}"), &update)?;
    }
    Ok(())
}

fn ops_of(conn: &Connection, card: &str) -> CommandResult<Vec<String>> {
    let mut stmt = conn
        .prepare_cached("select op from card_move_ends where card_id = ?1")
        .map_err(db_err)?;
    let rows = stmt.query_map([card], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub(crate) fn involved(conn: &Connection, card: &str) -> CommandResult<bool> {
    Ok(!ops_of(conn, card)?.is_empty())
}

// Every move connected to the card, through either end.
fn component(conn: &Connection, card: &str) -> CommandResult<BTreeMap<String, Node>> {
    let mut nodes = BTreeMap::new();
    let mut queue = vec![card.to_string()];
    let mut seen = BTreeSet::new();
    while let Some(card) = queue.pop() {
        if !seen.insert(card.clone()) {
            continue;
        }
        for op in ops_of(conn, &card)? {
            if nodes.contains_key(&op) {
                continue;
            }
            let doc = read(conn, &op)?;
            if let Some(meta) = meta_of(&doc) {
                queue.push(meta.from.clone());
                queue.push(meta.to.clone());
                nodes.insert(op, Node { meta, doc });
            }
        }
    }
    Ok(nodes)
}

// A run of moves with one current owner. Only the first run from the original
// card inherits its history; a competing move's run is a card of its own.
struct Path {
    ops: Vec<String>,
    inherits: bool,
}

fn paths(nodes: &BTreeMap<String, Node>) -> Vec<Path> {
    // A move follows the one that made its card; moves of one card compete.
    let made: BTreeMap<&str, &str> = nodes
        .iter()
        .rev()
        .map(|(op, node)| (node.meta.to.as_str(), op.as_str()))
        .collect();
    let mut children: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    let mut roots = BTreeSet::new();
    for (op, node) in nodes {
        let key = match made.get(node.meta.from.as_str()) {
            Some(parent) => parent.to_string(),
            None => {
                let key = format!("card:{}", node.meta.from);
                roots.insert(key.clone());
                key
            }
        };
        children.entry(key).or_default().push(op);
    }
    // The latest wins: after an undo, cutting the card again replaces the move.
    for competing in children.values_mut() {
        competing.sort_by_key(|op| std::cmp::Reverse((nodes[*op].meta.at, *op)));
    }
    let mut result = Vec::new();
    let mut starts: Vec<(String, bool)> = Vec::new();
    for root in roots {
        for (index, op) in children[&root].iter().enumerate() {
            starts.push((op.to_string(), index == 0));
        }
    }
    let mut visited = BTreeSet::new();
    while let Some((start, inherits)) = starts.pop() {
        let mut ops = Vec::new();
        let mut current = Some(start);
        while let Some(op) = current.take() {
            if !visited.insert(op.clone()) {
                break;
            }
            let next = children.get(&op).cloned().unwrap_or_default();
            for loser in next.iter().skip(1) {
                starts.push((loser.to_string(), false));
            }
            ops.push(op);
            current = next.first().map(|op| op.to_string());
        }
        if !ops.is_empty() {
            result.push(Path { ops, inherits });
        }
    }
    result.sort_by(|a, b| a.ops[0].cmp(&b.ops[0]));
    result
}

fn owner<'a>(nodes: &'a BTreeMap<String, Node>, path: &Path) -> &'a str {
    &nodes[path.ops.last().unwrap()].meta.to
}

// The cards of a path, newest first.
fn cards_of<'a>(nodes: &'a BTreeMap<String, Node>, path: &Path) -> Vec<&'a str> {
    let moved = path.ops.iter().rev().map(|op| nodes[op].meta.to.as_str());
    let original = path
        .inherits
        .then(|| nodes[&path.ops[0]].meta.from.as_str());
    moved.chain(original).collect()
}

fn path_of(nodes: &BTreeMap<String, Node>, card: &str) -> Option<Path> {
    paths(nodes)
        .into_iter()
        .find(|path| cards_of(nodes, path).contains(&card))
}

fn live_in(conn: &Connection, card: &str) -> CommandResult<Option<String>> {
    conn.query_row(
        "select module_id from cards where id = ?1 and deleted_at is null",
        [card],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_err)
}

// The card that holds a path's history here.
fn holder<'a>(
    conn: &Connection,
    nodes: &'a BTreeMap<String, Node>,
    path: &Path,
) -> CommandResult<&'a str> {
    for card in cards_of(nodes, path) {
        if live_in(conn, card)?.is_some() {
            return Ok(card);
        }
    }
    Ok(owner(nodes, path))
}

fn row_state(conn: &Connection, card: &str) -> CommandResult<Option<String>> {
    conn.query_row(
        &format!("select {} from cards where id = ?1", card_state_json()),
        [card],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_err)
}

fn set_state(conn: &Connection, card: &str, state: &str) -> CommandResult<bool> {
    let fields = crate::cards::CARD_STATE_FIELDS;
    let set: Vec<_> = fields
        .iter()
        .map(|field| format!("{field} = json_extract(?2, '$.{field}')"))
        .collect();
    let differs: Vec<_> = fields
        .iter()
        .map(|field| format!("{field} is not json_extract(?2, '$.{field}')"))
        .collect();
    conn.execute(
        &format!(
            "update cards set {} where id = ?1 and ({})",
            set.join(", "),
            differs.join(" or ")
        ),
        params![card, state],
    )
    .map(|rows| rows > 0)
    .map_err(db_err)
}

fn reset(conn: &Connection, card: &str) -> CommandResult<bool> {
    conn.execute(
        "update cards set due_at = created_at, stability = 0, stability_fast = 0, difficulty = 0,
             scheduled_days = 0, learning_step = 0, reps = 0, lapses = 0, state = 0,
             schedule_status = 'new', last_review_at = null, fsrs_model = null
         where id = ?1 and (reps > 0 or last_review_at is not null)",
        [card],
    )
    .map(|rows| rows > 0)
    .map_err(db_err)
}

// What the ordinary review documents say about the cards of these moves.
struct Ordinary {
    states: BTreeMap<String, String>,
    logs: BTreeMap<String, String>,
    gone: BTreeSet<String>,
}

fn ordinary(conn: &Connection, nodes: &BTreeMap<String, Node>) -> CommandResult<Ordinary> {
    let modules: BTreeSet<_> = nodes
        .values()
        .flat_map(|node| [&node.meta.from_module, &node.meta.to_module])
        .collect();
    let mut found = Ordinary {
        states: BTreeMap::new(),
        logs: BTreeMap::new(),
        gone: BTreeSet::new(),
    };
    for module in modules {
        let doc = load_doc(conn, &review_doc_id(module))?;
        for (card, state) in string_entries(&doc, "cards") {
            if !valid_state(&state) {
                continue;
            }
            let here = nodes.values().any(|node| {
                (node.meta.from == card && node.meta.from_module == *module)
                    || (node.meta.to == card && node.meta.to_module == *module)
            });
            if here {
                found.states.insert(card, state);
            }
        }
        for (id, row) in string_entries(&doc, "log") {
            if row.is_empty() {
                found.gone.insert(id);
            } else if card_of(&row)
                .is_some_and(|card| nodes.values().any(|n| n.meta.from == card || n.meta.to == card))
            {
                found.logs.insert(id, row);
            }
        }
    }
    Ok(found)
}

fn reviewed_in(row: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(row)
        .ok()?
        .get("review_time")?
        .as_i64()
}

pub(crate) fn card_of(row: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(row)
        .ok()?
        .get("card_id")?
        .as_str()
        .map(str::to_string)
}

// Copies late reviews of these cards into the moves, where they survive the
// deletion of the note they were made in.
pub(crate) fn fold(conn: &Connection, card: &str) -> CommandResult<()> {
    let nodes = component(conn, card)?;
    let found = ordinary(conn, &nodes)?;
    let known: BTreeSet<String> = nodes
        .values()
        .flat_map(|n| entries(&n.doc, "own").into_keys().chain(entries(&n.doc, "carried").into_keys()))
        .collect();
    let paths = paths(&nodes);
    for path in paths {
        let first = &path.ops[0];
        let node = &nodes[first];
        let mut rows: Vec<(String, String, String, String)> = Vec::new();
        if path.inherits {
            if let Some(state) = found.states.get(&node.meta.from) {
                if *state != node.meta.state {
                    // By review, so that copying an older one loses nothing.
                    let key = reviewed_at(state).to_string();
                    rows.push((first.clone(), "pred".into(), key, state.clone()));
                }
            }
        }
        for (id, row) in &found.logs {
            if known.contains(id) {
                continue;
            }
            let Some(card) = card_of(row) else { continue };
            if path.inherits && card == node.meta.from {
                rows.push((first.clone(), "carried".into(), id.clone(), row.clone()));
            } else if let Some(op) = path.ops.iter().find(|op| nodes[*op].meta.to == card) {
                rows.push((op.clone(), "own".into(), id.clone(), row.clone()));
            }
        }
        for op in &path.ops {
            let node = &nodes[op];
            let own = entries(&node.doc, "own");
            let carried = entries(&node.doc, "carried");
            for id in &found.gone {
                if own.contains_key(id) || carried.contains_key(id) {
                    rows.push((op.clone(), "gone".into(), id.clone(), "1".into()));
                }
            }
            let mine: Vec<_> = rows
                .iter()
                .filter(|row| row.0 == *op)
                .map(|row| (row.1.as_str(), row.2.as_str(), row.3.as_str()))
                .collect();
            write(conn, op, &node.doc, &mine)?;
        }
    }
    Ok(())
}

// Writes the owner, schedule and log that the moves add up to.
pub(crate) fn materialize(
    conn: &Connection,
    cards: impl IntoIterator<Item = String>,
) -> CommandResult<bool> {
    let mut done = BTreeSet::new();
    let mut changed = false;
    for card in cards {
        if done.contains(&card) {
            continue;
        }
        let nodes = component(conn, &card)?;
        for node in nodes.values() {
            done.insert(node.meta.from.clone());
            done.insert(node.meta.to.clone());
        }
        changed |= apply(conn, &nodes)?;
    }
    Ok(changed)
}

fn apply(conn: &Connection, nodes: &BTreeMap<String, Node>) -> CommandResult<bool> {
    if nodes.is_empty() {
        return Ok(false);
    }
    let found = ordinary(conn, nodes)?;
    let mut gone = found.gone.clone();
    let mut own_anywhere = BTreeSet::new();
    for node in nodes.values() {
        gone.extend(entries(&node.doc, "gone").into_keys());
        own_anywhere.extend(entries(&node.doc, "own").into_keys());
    }
    let carried_anywhere: BTreeSet<_> = nodes
        .values()
        .flat_map(|node| entries(&node.doc, "carried").into_keys())
        .collect();
    let undone: BTreeSet<i64> = nodes
        .values()
        .flat_map(|node| {
            entries(&node.doc, "carried")
                .into_iter()
                .chain(entries(&node.doc, "own"))
        })
        .filter(|(id, _)| gone.contains(id))
        .filter_map(|(_, row)| reviewed_in(&row))
        .collect();
    let mut changed = false;
    let paths = paths(nodes);
    let mut holders = BTreeSet::new();
    // Rows a winning path carries, and the cards those paths started from.
    let mut taken = BTreeSet::new();
    let mut original = BTreeSet::new();
    for path in paths.iter().filter(|path| path.inherits) {
        original.insert(nodes[&path.ops[0]].meta.from.clone());
        for op in &path.ops {
            taken.extend(entries(&nodes[op].doc, "carried").into_keys());
        }
    }
    for path in &paths {
        // An older card that is live as well gets its new id when its note is
        // indexed again.
        let current = holder(conn, nodes, path)?;
        holders.insert(current);
        if let Some(home) = live_in(conn, current)? {
            if !stale(conn, &home)? {
                for card in cards_of(nodes, path).into_iter().filter(|card| *card != current) {
                    conn.execute(
                        "delete from card_indexed_modules where module_id in (select module_id from cards where id = ?1 and deleted_at is null)",
                        [card],
                    )
                    .map_err(db_err)?;
                }
            }
        }
        let first = &nodes[&path.ops[0]];
        let mut rows = BTreeMap::new();
        for op in &path.ops {
            rows.extend(entries(&nodes[op].doc, "own"));
        }
        if path.inherits {
            let others = nodes.iter().filter(|(op, _)| !path.ops.contains(op));
            for (_, node) in others {
                // What a losing move carried, and reviews of the original
                // card made while that move was undone.
                rows.extend(
                    entries(&node.doc, "carried")
                        .into_iter()
                        .filter(|(id, _)| !own_anywhere.contains(id)),
                );
                rows.extend(
                    entries(&node.doc, "own")
                        .into_iter()
                        .filter(|(_, row)| card_of(row).as_ref() == Some(&first.meta.from)),
                );
            }
            for op in &path.ops {
                rows.extend(entries(&nodes[op].doc, "carried"));
            }
        }
        for (id, row) in &found.logs {
            let card = card_of(row).unwrap_or_default();
            let here = path.ops.iter().any(|op| nodes[op].meta.to == card)
                || (path.inherits && card == first.meta.from);
            if here && !own_anywhere.contains(id) {
                rows.insert(id.clone(), row.clone());
            }
        }
        if !path.inherits {
            rows.retain(|id, row| {
                !taken.contains(id) && !card_of(row).is_some_and(|card| original.contains(&card))
            });
        }
        let state = if path.inherits {
            // The card that holds it now, reviewed while a losing move of it
            // was undone.
            let restored = nodes
                .iter()
                .filter(|(op, node)| !path.ops.contains(op) && node.meta.from == current)
                .filter_map(|(_, node)| state_of(&node.doc, "state", current));
            restored
                .chain(schedule(nodes, &path.ops, &undone))
                .max_by_key(|state| reviewed_at(state))
        } else {
            path.ops
                .iter()
                .rev()
                .find_map(|op| state_of(&nodes[op].doc, "state", "state"))
        };
        if row_state(conn, current)?.is_none() {
            // Not indexed here yet. The moves keep these rows until it is; no
            // other card may show them meanwhile.
            for id in rows.keys() {
                if own_anywhere.contains(id) || carried_anywhere.contains(id) {
                    changed |= conn
                        .execute("delete from review_log where sync_id = ?1", [id])
                        .map_err(db_err)?
                        > 0;
                }
            }
            continue;
        }
        changed |= match state {
            Some(state) => set_state(conn, current, &state)?,
            None => reset(conn, current)?,
        };
        for (id, row) in rows {
            if gone.contains(&id) {
                continue;
            }
            changed |= crate::sync::insert_log(conn, &id, &row, current)? > 0;
            conn.execute(
                "update review_log set card_id = ?2 where sync_id = ?1 and card_id <> ?2",
                params![id, current],
            )
            .map_err(db_err)?;
        }
    }
    for node in nodes.values() {
        for card in [&node.meta.from, &node.meta.to] {
            if !holders.contains(card.as_str()) {
                changed |= reset(conn, card)?;
            }
        }
    }
    for id in gone {
        changed |= conn
            .execute("delete from review_log where sync_id = ?1", [id])
            .map_err(db_err)?
            > 0;
    }
    Ok(changed)
}

// A review or undo made here on a card that owns a moved history.
pub(crate) fn record(
    conn: &Connection,
    card: &str,
    state: &str,
    added: Option<&(String, String)>,
    removed: Option<&str>,
) -> CommandResult<()> {
    let nodes = component(conn, card)?;
    let Some(path) = path_of(&nodes, card) else {
        return Ok(());
    };
    if holder(conn, &nodes, &path)? != card {
        return Ok(());
    }
    let op = path.ops.last().unwrap();
    let mut rows = vec![("state", "state", state)];
    // If this move is undone or loses, a review of the card it started from
    // still counts.
    if nodes[op].meta.from == card {
        rows.push(("state", card, state));
    }
    if let Some((id, row)) = added {
        rows.push(("own", id, row));
    }
    if let Some(id) = removed {
        rows.push(("gone", id, "1"));
    }
    write(conn, op, &nodes[op].doc, &rows)
}

// Merges a received move. Returns its cards, or None if it is not complete.
pub(crate) fn receive(conn: &Connection, op: &str, updates: &[Vec<u8>]) -> CommandResult<Option<String>> {
    let doc = read(conn, op)?;
    for bytes in updates {
        let applied = Update::decode_v1(bytes)
            .map_err(db_err)
            .and_then(|update| doc.transact_mut().apply_update(update).map_err(db_err));
        // One bad move must not stop the rest of the vault from syncing.
        if let Err(error) = applied {
            eprintln!("Skipped a malformed update of card move {op}: {error}");
        }
    }
    store(conn, op, &doc)?;
    Ok(meta_of(&doc).map(|meta| meta.from))
}

pub(crate) fn snapshot(conn: &Connection, op: &str) -> CommandResult<Option<Vec<u8>>> {
    conn.query_row("select doc from card_moves where op = ?1", [op], |r| r.get(0))
        .optional()
        .map_err(db_err)
}

pub(crate) fn seed(conn: &Connection) -> CommandResult<()> {
    conn.execute(
        "insert into sync_outbox (doc, bytes) select ?1 || op, doc from card_moves order by op",
        [PREFIX],
    )
    .map(|_| ())
    .map_err(db_err)
}

// The cards of this note that moves start or end at.
pub(crate) fn cards_in(conn: &Connection, module: &str) -> CommandResult<BTreeSet<String>> {
    let mut stmt = conn
        .prepare_cached("select distinct card_id from card_move_ends where module_id = ?1")
        .map_err(db_err)?;
    let rows = stmt.query_map([module], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

fn stale(conn: &Connection, module: &str) -> CommandResult<bool> {
    conn.query_row(
        "select exists(select 1 from card_stale_modules where module_id = ?1)",
        [module],
        |r| r.get(0),
    )
    .map_err(db_err)
}

// The note's cards were read from its text as of `update`, or as it is now.
pub(crate) fn indexed(conn: &Connection, module: &str, update: Option<i64>) -> CommandResult<()> {
    conn.execute(
        "delete from card_stale_modules where module_id = ?1 and update_id <= coalesce(?2, update_id)",
        params![module, update],
    )
    .map(|_| ())
    .map_err(db_err)
}

// Whether a card in a note's text must get a new id, because its history is
// held by another card. `snapshot` is every card in that text: one of them
// missing from it is not live any more.
pub(crate) fn renews(
    conn: &Connection,
    module: &str,
    card: &str,
    snapshot: &BTreeSet<&str>,
) -> CommandResult<bool> {
    let nodes = component(conn, card)?;
    let Some(path) = path_of(&nodes, card) else {
        return Ok(false);
    };
    // The paste itself has not been indexed here, so this is a copy of it.
    let elsewhere = nodes
        .values()
        .any(|node| node.meta.to == card && node.meta.to_module != module);
    if elsewhere && row_state(conn, card)?.is_none() {
        return Ok(true);
    }
    for newer in cards_of(&nodes, &path) {
        if newer == card {
            break;
        }
        match live_in(conn, newer)? {
            // That note may just have lost the card, as when a paste and its
            // cut are undone. Indexing it settles which of the two this is.
            Some(home) if home != module && stale(conn, &home)? => {},
            Some(home) if home != module => return Ok(true),
            _ if snapshot.contains(newer) => return Ok(true),
            _ => {}
        }
    }
    Ok(false)
}

fn append(
    conn: &Connection,
    op: &str,
    from: &str,
    to: &str,
    to_module: &str,
    at: i64,
) -> CommandResult<()> {
    conn.execute(
        "update review_log set sync_id = lower(hex(randomblob(16))) where card_id = ?1 and sync_id is null",
        [from],
    )
    .map_err(db_err)?;
    let from_module: String = conn
        .query_row("select module_id from cards where id = ?1", [from], |r| r.get(0))
        .map_err(db_err)?;
    let meta = Meta {
        from: from.into(),
        from_module,
        to: to.into(),
        to_module: to_module.into(),
        at,
        state: row_state(conn, from)?.ok_or("The card no longer exists")?,
    };
    let meta = serde_json::to_string(&meta).map_err(db_err)?;
    let logs: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(&format!(
                "select sync_id, {} from review_log where card_id = ?1",
                log_json()
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map([from], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    let mut rows = vec![("move", "meta", meta.as_str())];
    rows.extend(logs.iter().map(|(id, row)| ("carried", id.as_str(), row.as_str())));
    write(conn, op, &read(conn, op)?, &rows)
}

// Moves a cut card's history to the id its paste will use. Call it before the
// paste is saved: until the pasted card is indexed the history is kept but
// not reviewed, as for a cut that is never pasted.
pub fn transfer_card(
    db: &Db,
    op: String,
    from: String,
    to: String,
    to_module: String,
) -> CommandResult<Transfer> {
    if uuid::Uuid::parse_str(&op).is_err() {
        return Err("Invalid card move".into());
    }
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let result = transfer(&tx, &op, &from, &to, &to_module)?;
    tx.commit().map_err(db_err)?;
    Ok(result)
}

pub(crate) fn transfer(
    tx: &Connection,
    op: &str,
    from: &str,
    to: &str,
    to_module: &str,
) -> CommandResult<Transfer> {
    let replay = meta_of(&read(tx, op)?);
    if let Some(meta) = replay {
        return if meta.from == from && meta.to == to {
            Ok(Transfer::Moved)
        } else {
            Err("This card move was already used".into())
        };
    }
    if row_state(tx, from)?.is_none() {
        return Ok(Transfer::SourceMissing);
    }
    let nodes = component(tx, from)?;
    if !nodes.is_empty() {
        let Some(path) = path_of(&nodes, from) else {
            return Ok(Transfer::SourceMissing);
        };
        for newer in cards_of(&nodes, &path) {
            if newer == from {
                break;
            }
            if live_in(tx, newer)?.is_some() {
                return Ok(Transfer::SourceMissing);
            }
        }
    }
    let module: bool = tx
        .query_row("select exists(select 1 from modules where id = ?1)", [to_module], |r| r.get(0))
        .map_err(db_err)?;
    if !module || from == to || row_state(tx, to)?.is_some() || involved(tx, to)? {
        return Ok(Transfer::DestinationTaken);
    }
    // The cut card holds the history it is moved with.
    tx.execute("update cards set deleted_at = null where id = ?1", [from])
        .map_err(db_err)?;
    materialize(tx, [from.to_string()])?;
    // Later than every move known here, whatever this device's clock says.
    let known = nodes.values().map(|node| node.meta.at + 1).max().unwrap_or(0);
    let now = chrono::Utc::now().timestamp_millis();
    append(tx, op, from, to, to_module, now.max(known))?;
    tx.execute(
        "insert into cards (id, module_id, kind, front, back, section, due_at, created_at, updated_at, deleted_at)
         select ?2, ?3, kind, front, back, section, due_at, created_at, ?4, ?4 from cards where id = ?1",
        params![from, to, to_module, now],
    )
    .map_err(db_err)?;
    tx.execute(
        "update cards set deleted_at = coalesce(deleted_at, ?2), updated_at = ?2 where id = ?1",
        params![from, now],
    )
    .map_err(db_err)?;
    materialize(tx, [from.to_string()])?;
    Ok(Transfer::Moved)
}

#[cfg(test)]
mod tests;
