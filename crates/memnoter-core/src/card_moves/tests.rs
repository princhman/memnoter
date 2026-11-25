use super::*;
use crate::cards::{sync_cards, CardContent};
use crate::sync::{self, RemoteEntry};
use serde_json::json;
use std::path::PathBuf;

#[derive(Default)]
struct Server {
    log: Vec<(i64, String, Vec<u8>)>,
    head: i64,
}

struct Device {
    dir: PathBuf,
    db: Db,
    cursor: i64,
    notes: BTreeMap<String, Doc>,
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const NOTES: [&str; 2] = ["m1", "m2"];

impl Device {
    fn offline() -> Self {
        let dir = std::env::temp_dir().join(format!("notes-moves-{}", uuid::Uuid::new_v4()));
        let db = crate::open_db(&dir).unwrap();
        db.lock()
            .unwrap()
            .execute_batch("insert into modules (id, name) values ('m1', 'A'), ('m2', 'B'); insert into contents values ('m1', X''), ('m2', X'');")
            .unwrap();
        let notes = NOTES.iter().map(|m| (m.to_string(), Doc::new())).collect();
        Device { dir, db, cursor: 0, notes }
    }

    fn new() -> Self {
        let device = Self::offline();
        sync::enable(&mut device.db.lock().unwrap(), "{}").unwrap();
        device
    }

    fn set(&self, module: &str, map: &str, key: &str, value: &str) {
        let doc = &self.notes[module];
        let map = doc.get_or_insert_map(map);
        let update = {
            let mut txn = doc.transact_mut();
            map.insert(&mut txn, key, value);
            txn.encode_update_v1()
        };
        let conn = self.db.lock().unwrap();
        conn.execute("insert into contents_updates (module_id, bytes, created_at) select id, ?2, 0 from modules where id = ?1", params![module, update]).unwrap();
        sync::record_update(&conn, module, &update).unwrap();
    }

    // Adds or removes the block of a card. A removed block stays removed when
    // another device renews its id at the same time, as in a Yjs document.
    fn text(&self, module: &str, card: &str, present: bool) {
        let known = entries(&self.notes[module], "blocks");
        let block = known.iter().find(|(_, id)| *id == card).map(|(block, _)| block.clone());
        if block.is_none() {
            self.set(module, "blocks", card, card);
        }
        self.set(module, "removed", &block.unwrap_or(card.into()), if present { "" } else { "1" });
    }

    fn in_text(&self, module: &str) -> Vec<String> {
        let removed = entries(&self.notes[module], "removed");
        entries(&self.notes[module], "blocks")
            .into_iter()
            .filter(|(block, _)| removed.get(block).is_none_or(String::is_empty))
            .map(|(_, card)| card)
            .collect()
    }

    fn index(&self, module: &str) {
        loop {
            let cards: Vec<CardContent> = self
                .in_text(module)
                .iter()
                .map(|id| serde_json::from_value(json!({"id": id, "kind": "cloze", "front": id, "back": id, "section": []})).unwrap())
                .collect();
            let conflicts = sync_cards(&self.db, module.into(), cards).unwrap();
            if conflicts.is_empty() {
                return;
            }
            for card in conflicts {
                let block = entries(&self.notes[module], "blocks").into_iter().find(|(_, id)| *id == card).unwrap().0;
                self.set(module, "blocks", &block, &format!("{}:c1", uuid::Uuid::new_v4()));
            }
        }
    }

    fn review(&self, card: &str, at: i64) -> String {
        let conn = self.db.lock().unwrap();
        conn.execute(
            "update cards set reps = reps + 1, last_review_at = ?2, due_at = ?2 + 1000, stability = ?2 / 7.0,
                 difficulty = 5.5, scheduled_days = 3, state = 2, schedule_status = 'review', fsrs_model = 'm' where id = ?1",
            params![card, at],
        )
        .unwrap();
        conn.execute(
            "insert into review_log (card_id, rating, review_time, fsrs_model, state, schedule_status,
                 due_at, stability, stability_fast, difficulty, scheduled_days, learning_step, sync_id)
             values (?1, 3, ?2, 'm', 0, 'new', 0, 0, 0, 0, 0, 0, lower(hex(randomblob(16))))",
            params![card, at],
        )
        .unwrap();
        let row = conn.last_insert_rowid();
        sync::record_review(&conn, card, Some(row), None).unwrap();
        conn.query_row("select sync_id from review_log where id = ?1", [row], |r| r.get(0)).unwrap()
    }

    fn undo(&self, card: &str) -> Option<String> {
        let conn = self.db.lock().unwrap();
        let id: Option<String> = conn
            .query_row("delete from review_log where id = (select max(id) from review_log where card_id = ?1) returning sync_id", [card], |r| r.get(0))
            .optional()
            .unwrap();
        let id = id?;
        conn.execute("update cards set reps = max(reps - 1, 0) where id = ?1", [card]).unwrap();
        sync::record_review(&conn, card, None, Some(&id)).unwrap();
        Some(id)
    }

    fn transfer_as(&self, op: &str, from: &str, to: &str, module: &str) -> Transfer {
        transfer_card(&self.db, op.into(), from.into(), to.into(), module.into()).unwrap()
    }

    // The whole cut and paste, as the editor does it.
    fn cut_paste(&self, from: (&str, &str), to: (&str, &str), op: &str) -> Transfer {
        self.text(from.0, from.1, false);
        self.index(from.0);
        let result = self.transfer_as(op, from.1, to.1, to.0);
        self.text(to.0, to.1, true);
        self.index(to.0);
        result
    }

    fn push(&self, server: &mut Server) {
        let conn = self.db.lock().unwrap();
        for entry in sync::outbox(&conn, i64::MAX).unwrap() {
            if entry.bytes.is_empty() {
                server.log.retain(|(_, doc, _)| *doc != entry.doc);
            } else {
                assert!(entry.doc.len() <= 64 && entry.doc.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{}", entry.doc);
                server.head += 1;
                server.log.push((server.head, entry.doc, entry.bytes));
            }
        }
        conn.execute("delete from sync_outbox", []).unwrap();
    }

    fn receive(&mut self, entries: Vec<(i64, String, Vec<u8>)>, cursor: i64) {
        let entries = entries
            .into_iter()
            .map(|(seq, doc, bytes)| RemoteEntry { seq, doc, bytes })
            .collect();
        let result = sync::apply_remote(&mut self.db.lock().unwrap(), &self.dir.join("files"), entries, cursor).unwrap();
        self.cursor = cursor;
        for update in result.updates {
            if let Some(doc) = self.notes.get(&update.module_id) {
                doc.transact_mut()
                    .apply_update(Update::decode_v1(&update.update.bytes).unwrap())
                    .unwrap();
            }
        }
    }

    fn pull(&mut self, server: &Server) {
        let entries = server.log.iter().filter(|(seq, ..)| *seq > self.cursor).cloned().collect();
        self.receive(entries, server.head);
        for note in NOTES {
            self.index(note);
        }
        self.background();
    }

    // The app's background check of notes that are not indexed.
    fn background(&self) {
        for _ in 0..4 {
            let pending = serde_json::to_value(crate::cards::unindexed_card_modules(&self.db).unwrap()).unwrap();
            let pending: Vec<String> = pending.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
            if pending.is_empty() {
                return;
            }
            for note in pending {
                self.index(&note);
            }
        }
        panic!("indexing does not settle");
    }

    fn state(&self, card: &str) -> serde_json::Value {
        serde_json::from_str(&row_state(&self.db.lock().unwrap(), card).unwrap().unwrap()).unwrap()
    }

    fn reps(&self, card: &str) -> i64 {
        self.state(card)["reps"].as_i64().unwrap()
    }

    fn logs(&self, card: &str) -> BTreeSet<String> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("select sync_id from review_log where card_id = ?1").unwrap();
        let rows = stmt.query_map([card], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    // Live cards with their schedules, and every log row with its card.
    fn dump(&self) -> Vec<String> {
        let conn = self.db.lock().unwrap();
        let mut result = Vec::new();
        for sql in [
            format!("select module_id || ' ' || id || ' ' || case when reps = 0 and last_review_at is null then 'new' else {} end from cards where deleted_at is null order by id", card_state_json()),
            "select l.sync_id || ' ' || l.card_id from review_log l join cards c on c.id = l.card_id and c.deleted_at is null order by 1".into(),
        ] {
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            result.extend(rows.map(Result::unwrap));
        }
        result
    }

    // What a released app uploads after reviewing a card it thinks is new.
    fn legacy_review(server: &mut Server, module: &str, card: &str, id: &str) {
        let doc = Doc::new();
        let (cards, log) = (doc.get_or_insert_map("cards"), doc.get_or_insert_map("log"));
        let row = json!({"card_id": card, "rating": 3, "review_time": 77, "duration_ms": null, "fsrs_model": "m", "due_at": 0,
            "stability": 0, "stability_fast": 0, "difficulty": 0, "scheduled_days": 0, "learning_step": 0, "state": 0,
            "schedule_status": "new", "last_review_at": null});
        let mut state = row.clone();
        state["reps"] = json!(1);
        state["lapses"] = json!(0);
        state["last_review_at"] = json!(77);
        {
            let mut txn = doc.transact_mut();
            cards.insert(&mut txn, card, state.to_string());
            log.insert(&mut txn, id, row.to_string());
        }
        server.head += 1;
        server.log.push((server.head, review_doc_id(module), encode(&doc)));
    }
}

fn op(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

// Two devices that have the card "old" in m1, reviewed twice.
fn pair() -> (Server, Device, Device) {
    let mut server = Server::default();
    let (a, mut b) = (Device::new(), Device::new());
    a.text("m1", "old", true);
    a.text("m1", "sibling", true);
    a.index("m1");
    a.review("old", 1000);
    a.review("old", 2000);
    a.review("sibling", 500);
    a.push(&mut server);
    b.pull(&server);
    assert_eq!(b.reps("old"), 2);
    (server, a, b)
}

fn settle(server: &mut Server, devices: &mut [&mut Device]) {
    for _ in 0..4 {
        for device in devices.iter() {
            device.push(server);
        }
        for device in devices.iter_mut() {
            device.pull(server);
        }
    }
    for pair in devices.windows(2) {
        assert_eq!(pair[0].dump(), pair[1].dump());
    }
}

#[test]
fn a_move_keeps_every_field_and_log_row_with_sync_on_or_off() {
    for destination in NOTES {
        for device in [Device::offline(), Device::new()] {
            device.text("m1", "old", true);
            device.text("m1", "sibling", true);
            device.index("m1");
            device.review("old", 1000);
            device.review("old", 2000);
            device.review("sibling", 9);
            let (state, logs) = (device.state("old"), device.logs("old"));
            let sibling = (device.state("sibling"), device.logs("sibling"));
            assert_eq!(device.cut_paste(("m1", "old"), (destination, "new"), &op(1)), Transfer::Moved);
            assert_eq!(device.state("new"), state);
            assert_eq!(device.logs("new"), logs);
            assert_eq!(device.logs("old").len(), 0);
            assert_eq!(device.reps("old"), 0);
            assert_eq!((device.state("sibling"), device.logs("sibling")), sibling);
            // Replaying the call changes nothing; a second claim is refused.
            let before = device.dump();
            assert_eq!(device.transfer_as(&op(1), "old", "new", destination), Transfer::Moved);
            assert_eq!(device.transfer_as(&op(2), "old", "other", destination), Transfer::SourceMissing);
            assert_eq!(device.transfer_as(&op(3), "new", "sibling", destination), Transfer::DestinationTaken);
            assert_eq!(device.transfer_as(&op(4), "absent", "x", destination), Transfer::SourceMissing);
            assert_eq!(device.dump(), before);
            device.review("new", 3000);
            assert_eq!((device.reps("new"), device.logs("new").len()), (3, 3));
            device.undo("new");
            assert_eq!(device.logs("new"), logs);
        }
    }
}

#[test]
fn a_failed_write_leaves_the_card_where_it_was() {
    for table in ["card_moves", "card_move_ends", "cards", "review_log", "sync_outbox"] {
        let device = Device::new();
        device.text("m1", "old", true);
        device.index("m1");
        device.review("old", 1000);
        let before = device.dump();
        for event in ["insert", "update"] {
            device.db.lock().unwrap().execute_batch(&format!("create trigger fail_{event} before {event} on {table} begin select raise(abort, 'no'); end;")).unwrap();
        }
        assert!(transfer_card(&device.db, op(1), "old".into(), "new".into(), "m2".into()).is_err(), "{table}");
        device.db.lock().unwrap().execute_batch("drop trigger fail_insert; drop trigger fail_update;").unwrap();
        assert_eq!(device.dump(), before, "{table}");
        assert!(component(&device.db.lock().unwrap(), "old").unwrap().is_empty());
    }
}

#[test]
fn undo_and_redo_hand_the_history_back_and_forth() {
    let (mut server, a, mut b) = pair();
    let mut a = a;
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    a.review("new", 3000);
    settle(&mut server, &mut [&mut a, &mut b]);
    for (gone, back) in [(("m2", "new"), ("m1", "old")), (("m1", "old"), ("m2", "new")), (("m2", "new"), ("m1", "old"))] {
        a.text(gone.0, gone.1, false);
        a.index(gone.0);
        a.text(back.0, back.1, true);
        a.index(back.0);
        assert_eq!((a.reps(back.1), a.logs(back.1).len(), a.logs(gone.1).len()), (3, 3, 0));
        settle(&mut server, &mut [&mut a, &mut b]);
        assert_eq!((b.reps(back.1), b.logs(back.1).len()), (3, 3));
    }
    a.review("old", 4000);
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!(b.reps("old"), 4);
}

#[test]
fn undoing_only_the_cut_makes_the_restored_card_new() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    a.text("m1", "old", true);
    a.index("m1");
    settle(&mut server, &mut [&mut a, &mut b]);
    assert!(!a.in_text("m1").contains(&"old".to_string()));
    assert_eq!((b.reps("new"), b.logs("new").len()), (2, 2));
}

#[test]
fn every_delivery_order_gives_one_owner() {
    // Which of the move, the destination text and the source text come first.
    let orders: [[usize; 3]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for order in orders {
        let (mut server, mut a, mut b) = pair();
        let start = server.head;
        a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
        a.push(&mut server);
        let kind = |doc: &str| if doc.starts_with(PREFIX) { 0 } else if doc == "m2" { 1 } else { 2 };
        for step in order {
            let entries = server.log.iter().filter(|(seq, doc, _)| *seq > start && kind(doc) == step).cloned().collect();
            b.receive(entries, start);
            for note in NOTES {
                b.index(note);
            }
        }
        b.cursor = server.head;
        assert_eq!((b.reps("new"), b.logs("new").len(), b.logs("old").len()), (2, 2, 0), "{order:?}");
        settle(&mut server, &mut [&mut a, &mut b]);
    }
}

#[test]
fn a_fresh_device_and_a_compacted_vault_have_the_history() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    b.review("old", 2500);
    settle(&mut server, &mut [&mut a, &mut b]);
    a.review("new", 3000);
    settle(&mut server, &mut [&mut a, &mut b]);
    let doc = format!("{PREFIX}{}", op(1));
    let bytes = sync::snapshot(&a.db.lock().unwrap(), &doc).unwrap().unwrap();
    server.log.retain(|(_, name, _)| *name != doc);
    server.head += 1;
    server.log.push((server.head, doc, bytes));
    let mut fresh = Device::new();
    fresh.pull(&server);
    assert_eq!(fresh.logs("new").len(), 4);
    settle(&mut server, &mut [&mut a, &mut fresh]);
    // Turning sync off and on again publishes the moves once more.
    sync::disable(&a.db.lock().unwrap()).unwrap();
    sync::enable(&mut a.db.lock().unwrap(), "{}").unwrap();
    a.cursor = 0;
    settle(&mut server, &mut [&mut a, &mut b, &mut fresh]);
    assert_eq!(fresh.logs("new").len(), 4);
}

#[test]
fn a_new_card_in_the_emptied_line_keeps_its_own_history() {
    let (mut server, mut a, mut b) = pair();
    a.text("m1", "old", false);
    a.index("m1");
    a.push(&mut server);
    b.pull(&server);
    // The cut clears the line's id, so what is typed there gets its own.
    b.text("m1", "typed", true);
    b.index("m1");
    b.review("typed", 2600);
    a.transfer_as(&op(1), "old", "new", "m1");
    a.text("m1", "new", true);
    a.index("m1");
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!((a.reps("typed"), a.logs("typed").len()), (1, 1));
    assert_eq!((b.reps("new"), b.logs("new").len()), (2, 2));
}

#[test]
fn late_reviews_and_undos_of_the_old_card_arrive() {
    for reviewed_after in [false, true] {
        for undo in [false, true] {
            let (mut server, mut a, mut b) = pair();
            a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
            if reviewed_after {
                a.review("new", 3000);
            }
            if undo {
                b.undo("old");
            } else {
                b.review("old", 2500);
            }
            settle(&mut server, &mut [&mut a, &mut b]);
            let logs = 2 + i64::from(reviewed_after) + if undo { -1 } else { 1 };
            assert_eq!(a.logs("new").len() as i64, logs);
            // A review in the new place decides; until then the late one does.
            let reps = if reviewed_after { 3 } else if undo { 1 } else { 3 };
            assert_eq!(a.reps("new"), reps);
        }
    }
}

#[test]
fn two_devices_moving_one_card_agree_on_the_winner() {
    for (first, second) in [(op(1), op(2)), (op(2), op(1))] {
        for a_first in [true, false] {
            let (mut server, mut a, mut b) = pair();
            a.cut_paste(("m1", "old"), ("m2", "on-a"), &first);
            b.cut_paste(("m1", "old"), ("m2", "on-b"), &second);
            let a_row = a.review("on-a", 3000);
            let b_row = b.review("on-b", 3100);
            if a_first {
                a.push(&mut server);
                b.push(&mut server);
            } else {
                b.push(&mut server);
                a.push(&mut server);
            }
            settle(&mut server, &mut [&mut a, &mut b]);
            let (winner, loser, won, lost) = if first < second { ("on-a", "on-b", a_row, b_row) } else { ("on-b", "on-a", b_row, a_row) };
            assert_eq!(a.logs(winner).len(), 3);
            assert!(a.logs(winner).contains(&won));
            assert_eq!(a.logs(loser), BTreeSet::from([lost]));
        }
    }
}

#[test]
fn deleting_the_source_note_keeps_the_history() {
    for deleted_first in [false, true] {
        let (mut server, mut a, mut b) = pair();
        a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
        b.review("old", 2500);
        if !deleted_first {
            settle(&mut server, &mut [&mut a, &mut b]);
        }
        {
            let device = if deleted_first { &b } else { &a };
            let mut conn = device.db.lock().unwrap();
            sync::record_module(&conn, "m1", sync::VaultChange::Deleted).unwrap();
            crate::content::delete_module_data(&mut conn, &device.dir.join("files"), "m1").unwrap();
        }
        for device in [&mut a, &mut b] {
            device.notes.insert("m1".into(), Doc::new());
        }
        for _ in 0..3 {
            for device in [&a, &b] {
                device.push(&mut server);
            }
            for device in [&mut a, &mut b] {
                let entries = server.log.iter().filter(|(seq, ..)| *seq > device.cursor).cloned().collect();
                device.receive(entries, server.head);
                device.index("m2");
            }
        }
        let mut fresh = Device::offline();
        sync::enable(&mut fresh.db.lock().unwrap(), "{}").unwrap();
        fresh.db.lock().unwrap().execute("delete from sync_outbox", []).unwrap();
        fresh.receive(server.log.clone(), server.head);
        fresh.index("m2");
        let logs = if deleted_first { 2 } else { 3 };
        for device in [&a, &b, &fresh] {
            assert!(device.logs("new").len() >= logs, "deleted first: {deleted_first}");
            assert!(device.reps("new") >= 2);
        }
        assert_eq!(a.state("new"), fresh.state("new"));
        assert_eq!(a.state("new"), b.state("new"));
        assert_eq!(a.logs("new"), b.logs("new"));
    }
}

#[test]
fn a_released_app_does_not_reset_the_schedule() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    Device::legacy_review(&mut server, "m2", "new", "legacy-row");
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!(b.reps("new"), 2);
    assert!(b.logs("new").contains("legacy-row"));
    assert_eq!(b.logs("new").len(), 3);
}

#[test]
fn a_renewed_source_id_is_a_new_card() {
    // Splitting the source block on another device renews its id.
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    b.text("m1", "old", false);
    b.text("m1", "renewed", true);
    b.index("m1");
    b.review("renewed", 2500);
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!((a.reps("new"), a.logs("new").len()), (2, 2));
    assert_eq!((a.reps("renewed"), a.logs("renewed").len()), (1, 1));
}

struct Random(u64);
impl Random {
    fn next(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

#[test]
fn random_moves_reviews_and_delivery_converge() {
    let seeds = std::env::var("MOVE_SEEDS").ok().and_then(|n| n.parse().ok()).unwrap_or(40);
    let only: Option<u64> = std::env::var("MOVE_SEED").ok().and_then(|n| n.parse().ok());
    for seed in 1..=seeds {
        if only.is_some_and(|only| only != seed) {
            continue;
        }
        let mut random = Random(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut server = Server::default();
        let mut devices = [Device::new(), Device::new(), Device::new()];
        devices[0].text("m1", "one", true);
        devices[0].text("m2", "two", true);
        devices[0].text("m1", "witness", true);
        devices[0].index("m1");
        devices[0].index("m2");
        let mut rated = BTreeSet::new();
        let mut undone = BTreeSet::new();
        let mut clock = 1000;
        for card in ["one", "two", "witness"] {
            clock += 1;
            rated.insert(devices[0].review(card, clock));
        }
        let witness = devices[0].state("witness");
        devices[0].push(&mut server);
        for device in &mut devices {
            device.pull(&server);
        }
        for step in 0..40 {
            clock += 10;
            let device = &mut devices[random.next(3)];
            let module = NOTES[random.next(2)];
            let other = NOTES[random.next(2)];
            let cards: Vec<_> = device.in_text(module).into_iter().filter(|c| c != "witness").collect();
            match random.next(9) {
                0 if !cards.is_empty() => {
                    let card = &cards[random.next(cards.len())];
                    let id = uuid::Uuid::from_u64_pair(random.0, step).to_string();
                    device.cut_paste((module, card), (other, &format!("s{step}")), &id);
                }
                1 | 2 if !cards.is_empty() => {
                    let card = &cards[random.next(cards.len())];
                    let live: bool = device.db.lock().unwrap().query_row("select exists(select 1 from cards where id = ?1 and deleted_at is null)", [card], |r| r.get(0)).unwrap();
                    if live {
                        rated.insert(device.review(card, clock));
                    }
                }
                3 if !cards.is_empty() => {
                    undone.extend(device.undo(&cards[random.next(cards.len())]));
                }
                // Undo and redo of earlier cuts, pastes and deletions.
                4 | 5 => {
                    let blocks: Vec<_> = entries(&device.notes[module], "blocks").into_values().filter(|c| c != "witness").collect();
                    if !blocks.is_empty() {
                        let card = &blocks[random.next(blocks.len())];
                        let present = device.in_text(module).contains(card);
                        device.text(module, card, !present);
                        device.index(module);
                    }
                }
                6 | 7 => device.push(&mut server),
                8 if random.next(2) == 0 => {
                    let entries = server.log.iter().filter(|(seq, ..)| *seq > device.cursor).cloned().collect();
                    device.receive(entries, server.head);
                    if random.next(2) == 0 {
                        device.index(module);
                    }
                }
                _ => device.pull(&server),
            }
        }
        for _ in 0..5 {
            for device in &devices {
                device.push(&mut server);
            }
            for device in &mut devices {
                device.pull(&server);
            }
        }
        for device in &devices[1..] {
            assert_eq!(devices[0].dump(), device.dump(), "seed {seed}");
        }
        let mut fresh = Device::new();
        fresh.pull(&server);
        assert_eq!(devices[0].dump(), fresh.dump(), "seed {seed}, fresh device");
        let mut kept = BTreeSet::new();
        for device in &devices {
            let conn = device.db.lock().unwrap();
            let mut stmt = conn.prepare("select sync_id from review_log").unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            kept.extend(rows.map(Result::unwrap));
        }
        let expected: BTreeSet<String> = rated.difference(&undone).cloned().collect();
        assert_eq!(kept, expected, "seed {seed}");
        assert_eq!(devices[0].state("witness"), witness, "seed {seed}");
    }
}

#[test]
fn a_move_made_with_sync_off_is_published_when_it_is_turned_on() {
    let (mut server, mut a, mut b) = pair();
    a.push(&mut server);
    sync::disable(&a.db.lock().unwrap()).unwrap();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    a.review("new", 3000);
    sync::enable(&mut a.db.lock().unwrap(), "{}").unwrap();
    // The sync-off text edits reach the server with the note itself.
    for note in NOTES {
        let bytes = encode(&a.notes[note]);
        sync::record_update(&a.db.lock().unwrap(), note, &bytes).unwrap();
    }
    a.cursor = 0;
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!((b.reps("new"), b.logs("new").len(), b.logs("old").len()), (3, 3, 0));
    assert!(server.log.iter().any(|(_, doc, _)| doc.starts_with(PREFIX)));
}

#[test]
fn a_late_review_made_here_counts_as_soon_as_the_move_arrives() {
    let (mut server, a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    b.review("old", 2500);
    a.push(&mut server);
    b.pull(&server);
    assert_eq!((b.reps("new"), b.logs("new").len()), (3, 3));
}

#[test]
fn an_undone_review_stays_undone_after_its_review_document_is_dropped() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    settle(&mut server, &mut [&mut a, &mut b]);
    a.undo("new");
    a.push(&mut server);
    server.log.retain(|(_, doc, _)| doc != "r-m2" && doc != "r-m1");
    b.pull(&server);
    assert_eq!((b.reps("new"), b.logs("new").len()), (1, 1));
}

#[test]
fn a_malformed_move_does_not_stop_sync() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    let bad_state = Doc::new();
    let map = bad_state.get_or_insert_map("move");
    map.insert(
        &mut bad_state.transact_mut(),
        "meta",
        json!({"from": "sibling", "from_module": "m1", "to": "z", "to_module": "m2", "prev": null, "state": "{}"}).to_string(),
    );
    let cyclic = Doc::new();
    let map = cyclic.get_or_insert_map("move");
    let state = a.state("sibling").to_string();
    map.insert(
        &mut cyclic.transact_mut(),
        "meta",
        json!({"from": "loop", "from_module": "m1", "to": "loop", "to_module": "m1", "prev": op(9), "state": state}).to_string(),
    );
    for (n, bytes) in [(7, vec![1, 2, 3]), (8, encode(&bad_state)), (9, encode(&cyclic))] {
        server.head += 1;
        server.log.push((server.head, format!("{PREFIX}{}", op(n)), bytes));
    }
    let bad = Doc::new();
    for map in ["state", "pred"] {
        bad.get_or_insert_map(map).insert(&mut bad.transact_mut(), "state", "{}");
    }
    bad.get_or_insert_map("own").insert(&mut bad.transact_mut(), "row", "{}");
    server.head += 1;
    server.log.push((server.head, format!("{PREFIX}{}", op(1)), encode(&bad)));
    b.text("m1", "loop", true);
    b.index("m1");
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!((b.reps("new"), b.reps("sibling")), (2, 1));
}

#[test]
fn undoing_a_same_note_paste_and_cut_at_once_restores_the_card() {
    let (mut server, mut a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m1", "new"), &op(1));
    a.text("m1", "new", false);
    a.text("m1", "old", true);
    a.index("m1");
    assert_eq!((a.reps("old"), a.logs("old").len()), (2, 2));
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!(b.reps("old"), 2);
}

#[test]
fn a_device_that_never_saw_the_paste_has_the_restored_card() {
    let (mut server, mut a, _) = pair();
    a.text("m1", "old", false);
    a.transfer_as(&op(1), "old", "new", "m2");
    a.text("m2", "new", true);
    a.text("m2", "new", false);
    a.text("m1", "old", true);
    a.index("m1");
    assert_eq!((a.reps("old"), a.logs("old").len()), (2, 2));
    let mut fresh = Device::new();
    settle(&mut server, &mut [&mut a, &mut fresh]);
    assert_eq!((fresh.reps("old"), fresh.logs("old").len()), (2, 2));
}

#[test]
fn the_source_note_survives_deleting_the_destination_note() {
    let (_, a, _) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    a.review("new", 3000);
    crate::content::delete_module_data(&mut a.db.lock().unwrap(), &a.dir.join("files"), "m2").unwrap();
    a.text("m1", "old", true);
    a.index("m1");
    assert_eq!((a.reps("old"), a.logs("old").len()), (3, 3));
}

#[test]
fn a_late_rating_seen_before_the_move_outlives_its_note() {
    let (mut server, mut a, mut b) = pair();
    let mut observer = Device::new();
    observer.pull(&server);
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    b.review("old", 2500);
    b.push(&mut server);
    observer.pull(&server);
    a.push(&mut server);
    observer.pull(&server);
    assert_eq!(observer.logs("new").len(), 3);
    observer.push(&mut server);
    server.log.retain(|(_, doc, _)| doc != "r-m1");
    let mut fresh = Device::new();
    fresh.pull(&server);
    assert_eq!((fresh.reps("new"), fresh.logs("new").len()), (3, 3));
    settle(&mut server, &mut [&mut a, &mut b, &mut observer]);
}

#[test]
fn concurrent_moves_that_are_both_undone_keep_the_schedule() {
    let (mut server, mut a, mut b) = pair();
    for (device, id, n) in [(&a, "on-a", 1), (&b, "on-b", 2)] {
        device.cut_paste(("m1", "old"), ("m2", id), &op(n));
        device.text("m2", id, false);
        device.index("m2");
        device.text("m1", "old", true);
        device.index("m1");
    }
    settle(&mut server, &mut [&mut a, &mut b]);
    assert_eq!((a.reps("old"), a.logs("old").len()), (2, 2));
}

#[test]
fn a_copy_in_another_note_does_not_take_a_paste_that_is_not_indexed_yet() {
    let (mut server, a, mut b) = pair();
    a.cut_paste(("m1", "old"), ("m2", "new"), &op(1));
    a.push(&mut server);
    let entries = server.log.iter().filter(|(_, doc, _)| doc.starts_with(PREFIX)).cloned().collect();
    b.receive(entries, server.head);
    let copy = serde_json::from_value(json!({"id": "new", "kind": "cloze", "front": "x", "back": "x", "section": []})).unwrap();
    assert_eq!(sync_cards(&b.db, "m1".into(), vec![copy]).unwrap(), vec!["new"]);
}
