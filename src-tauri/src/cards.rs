// Flashcard storage. Cards are written in note text; the editor extracts them
// and syncs them here. Scheduling is computed in TypeScript with ts-fsrs, so
// this module only stores card content, the FSRS state and the review log.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};

use super::{db_err, CommandResult, Db};

pub(crate) fn migrate_flashcards(conn: &Connection) -> CommandResult<()> {
    conn.execute_batch(
        "
        -- front and back are JSON whose shape depends on kind (basic, cloze,
        -- later occlusion); only the review renderer interprets them.
        -- The FSRS columns mirror a ts-fsrs v6 card. A new card is due at once.
        create table if not exists cards (
            id TEXT PRIMARY KEY,
            module_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            front TEXT NOT NULL,
            back TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            stability REAL NOT NULL DEFAULT 0,
            stability_fast REAL NOT NULL DEFAULT 0,
            difficulty REAL NOT NULL DEFAULT 0,
            scheduled_days REAL NOT NULL DEFAULT 0,
            learning_step INTEGER NOT NULL DEFAULT 0,
            reps INTEGER NOT NULL DEFAULT 0,
            lapses INTEGER NOT NULL DEFAULT 0,
            state INTEGER NOT NULL DEFAULT 0,
            schedule_status TEXT NOT NULL DEFAULT 'new',
            last_review_at INTEGER,
            fsrs_model TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        create table if not exists card_indexed_modules (
            module_id TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE
        );

        create index if not exists cards_module on cards(module_id);
        create index if not exists cards_due on cards(due_at) where deleted_at is null;

        -- One row per rating. The card fields are the state before the review,
        -- as in a ts-fsrs revlog, so parameters can be optimised later.
        create table if not exists review_log (
            id INTEGER PRIMARY KEY,
            card_id TEXT NOT NULL,
            rating INTEGER NOT NULL,
            review_time INTEGER NOT NULL,
            duration_ms INTEGER,
            fsrs_model TEXT NOT NULL,
            state INTEGER NOT NULL,
            schedule_status TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            last_review_at INTEGER,
            stability REAL NOT NULL,
            stability_fast REAL NOT NULL,
            difficulty REAL NOT NULL,
            scheduled_days REAL NOT NULL,
            learning_step INTEGER NOT NULL,
            FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
        );

        create index if not exists review_log_card on review_log(card_id, review_time);",
    )
    .map_err(db_err)
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct CardContent {
    id: String,
    kind: String,
    front: serde_json::Value,
    back: serde_json::Value,
}

// The scheduling fields shared by a stored card and a review log row.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsrsState {
    due_at: i64,
    stability: f64,
    stability_fast: f64,
    difficulty: f64,
    scheduled_days: f64,
    learning_step: i64,
    state: i64,
    schedule_status: String,
    last_review_at: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Card {
    id: String,
    module_id: String,
    module_name: String,
    kind: String,
    front: serde_json::Value,
    back: serde_json::Value,
    #[serde(flatten)]
    fsrs: FsrsState,
    reps: i64,
    lapses: i64,
    fsrs_model: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedCard {
    #[serde(flatten)]
    fsrs: FsrsState,
    reps: i64,
    lapses: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewLog {
    #[serde(flatten)]
    before: FsrsState,
    rating: i64,
    review_time: i64,
    duration_ms: Option<i64>,
    fsrs_model: String,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DueCount {
    module_id: String,
    count: i64,
}

fn json_text(value: &serde_json::Value) -> CommandResult<String> {
    serde_json::to_string(value).map_err(db_err)
}

// Upserts the module's cards and soft-deletes the ones no longer in its text.
// Content edits never touch the FSRS state, and a card that comes back (undo,
// or retyping the syntax) is restored with its history. Returns the ids that
// are live in another module (the block was copied between notes); the editor
// gives those blocks new ids instead of moving another note's card.
fn sync_module_cards(
    conn: &mut Connection,
    module_id: &str,
    cards: &[CardContent],
    now: i64,
) -> CommandResult<Vec<String>> {
    let tx = conn.transaction().map_err(db_err)?;
    // A final editor sync may arrive after the module was deleted.
    if !tx
        .query_row(
            "select exists(select 1 from modules where id = ?1)",
            [module_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_err)?
    {
        return Ok(Vec::new());
    }
    let mut conflicts = Vec::new();
    {
        let mut upsert = tx
            .prepare(
                "insert into cards (id, module_id, kind, front, back, due_at, created_at, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)
                 on conflict(id) do update set
                     updated_at = case
                         when cards.deleted_at is not null
                           or cards.module_id is not excluded.module_id
                           or cards.kind is not excluded.kind
                           or cards.front is not excluded.front
                           or cards.back is not excluded.back
                         then excluded.updated_at else cards.updated_at end,
                     module_id = excluded.module_id,
                     kind = excluded.kind,
                     front = excluded.front,
                     back = excluded.back,
                     deleted_at = null
                 where cards.module_id = excluded.module_id or cards.deleted_at is not null",
            )
            .map_err(db_err)?;
        for card in cards {
            let changed = upsert
                .execute(params![
                    card.id,
                    module_id,
                    card.kind,
                    json_text(&card.front)?,
                    json_text(&card.back)?,
                    now
                ])
                .map_err(db_err)?;
            if changed == 0 {
                conflicts.push(card.id.clone());
            }
        }
    }
    let kept = serde_json::to_string(
        &cards
            .iter()
            .filter(|card| !conflicts.contains(&card.id))
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>(),
    )
    .map_err(db_err)?;
    tx.execute(
        "update cards set deleted_at = ?2, updated_at = ?2
         where module_id = ?1 and deleted_at is null
           and id not in (select value from json_each(?3))",
        params![module_id, now, kept],
    )
    .map_err(db_err)?;
    tx.execute(
        "delete from card_indexed_modules where module_id = ?1",
        [module_id],
    )
    .map_err(db_err)?;
    if conflicts.is_empty() {
        tx.execute(
            "insert or ignore into card_indexed_modules (module_id) values (?1)",
            [module_id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(conflicts)
}

fn json_column(text: String) -> serde_json::Value {
    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
}

fn query_due_cards(
    conn: &Connection,
    module_id: Option<&str>,
    now: i64,
) -> CommandResult<Vec<Card>> {
    let mut stmt = conn
        .prepare(
            "select c.id, c.module_id, m.name, c.kind, c.front, c.back, c.due_at,
                    c.stability, c.stability_fast, c.difficulty, c.scheduled_days,
                    c.learning_step, c.state, c.schedule_status, c.last_review_at,
                    c.reps, c.lapses, c.fsrs_model
             from cards c join modules m on m.id = c.module_id
             where c.deleted_at is null and c.due_at <= ?1
               and (?2 is null or c.module_id = ?2)
             order by c.due_at, c.id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![now, module_id], |row| {
            Ok(Card {
                id: row.get(0)?,
                module_id: row.get(1)?,
                module_name: row.get(2)?,
                kind: row.get(3)?,
                front: json_column(row.get(4)?),
                back: json_column(row.get(5)?),
                fsrs: FsrsState {
                    due_at: row.get(6)?,
                    stability: row.get(7)?,
                    stability_fast: row.get(8)?,
                    difficulty: row.get(9)?,
                    scheduled_days: row.get(10)?,
                    learning_step: row.get(11)?,
                    state: row.get(12)?,
                    schedule_status: row.get(13)?,
                    last_review_at: row.get(14)?,
                },
                reps: row.get(15)?,
                lapses: row.get(16)?,
                fsrs_model: row.get(17)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

fn query_due_counts(conn: &Connection, now: i64) -> CommandResult<Vec<DueCount>> {
    let mut stmt = conn
        .prepare(
            "select module_id, count(*) from cards
             where deleted_at is null and due_at <= ?1
             group by module_id order by module_id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([now], |row| {
            Ok(DueCount {
                module_id: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

// Stores a review computed by ts-fsrs. `expected_reps` is the repetition count
// the review was computed from: a stale or repeated submission (a double key
// press, two windows) is rejected rather than applied twice.
fn save_review(
    conn: &mut Connection,
    card_id: &str,
    expected_reps: i64,
    card: &ReviewedCard,
    log: &ReviewLog,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let fsrs = &card.fsrs;
    let updated = tx
        .execute(
            "update cards set due_at = ?3, stability = ?4, stability_fast = ?5,
                 difficulty = ?6, scheduled_days = ?7, learning_step = ?8,
                 state = ?9, schedule_status = ?10, last_review_at = ?11,
                 reps = ?12, lapses = ?13, fsrs_model = ?14
             where id = ?1 and reps = ?2 and deleted_at is null",
            params![
                card_id,
                expected_reps,
                fsrs.due_at,
                fsrs.stability,
                fsrs.stability_fast,
                fsrs.difficulty,
                fsrs.scheduled_days,
                fsrs.learning_step,
                fsrs.state,
                fsrs.schedule_status,
                fsrs.last_review_at,
                card.reps,
                card.lapses,
                log.fsrs_model
            ],
        )
        .map_err(db_err)?;
    if updated == 0 {
        let exists: Option<i64> = tx
            .query_row(
                "select reps from cards where id = ?1 and deleted_at is null",
                [card_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?;
        return Err(match exists {
            Some(_) => "The card was reviewed elsewhere; reload the review".into(),
            None => "The card no longer exists".into(),
        });
    }
    let before = &log.before;
    tx.execute(
        "insert into review_log (card_id, rating, review_time, duration_ms, fsrs_model,
             state, schedule_status, due_at, last_review_at, stability, stability_fast,
             difficulty, scheduled_days, learning_step)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            card_id,
            log.rating,
            log.review_time,
            log.duration_ms,
            log.fsrs_model,
            before.state,
            before.schedule_status,
            before.due_at,
            before.last_review_at,
            before.stability,
            before.stability_fast,
            before.difficulty,
            before.scheduled_days,
            before.learning_step
        ],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

#[tauri::command(async)]
pub(crate) fn sync_cards(
    db: tauri::State<'_, Db>,
    module_id: String,
    cards: Vec<CardContent>,
) -> CommandResult<Vec<String>> {
    let mut conn = db.lock()?;
    sync_module_cards(&mut conn, &module_id, &cards, Utc::now().timestamp_millis())
}

#[tauri::command(async)]
pub(crate) fn due_cards(
    db: tauri::State<'_, Db>,
    module_id: Option<String>,
    now: i64,
) -> CommandResult<Vec<Card>> {
    let conn = db.lock()?;
    query_due_cards(&conn, module_id.as_deref(), now)
}

#[tauri::command(async)]
pub(crate) fn due_counts(db: tauri::State<'_, Db>, now: i64) -> CommandResult<Vec<DueCount>> {
    let conn = db.lock()?;
    query_due_counts(&conn, now)
}

#[tauri::command(async)]
pub(crate) fn review_card(
    db: tauri::State<'_, Db>,
    card_id: String,
    expected_reps: i64,
    card: ReviewedCard,
    log: ReviewLog,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    save_review(&mut conn, &card_id, expected_reps, &card, &log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{delete_module_data, open_db};
    use serde_json::json;
    use uuid::Uuid;

    struct Fixture {
        dir: std::path::PathBuf,
        db: Db,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("notes-cards-{}", Uuid::new_v4()));
            let db = open_db(&dir).unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute_batch(
                    "insert into modules values ('a', 'Algebra'), ('b', 'Biology');
                     insert into contents values ('a', X''), ('b', X'');",
                )
                .unwrap();
            Self { dir, db }
        }

        fn sync(&self, module: &str, cards: &[CardContent], now: i64) -> Vec<String> {
            sync_module_cards(&mut self.db.conn.lock().unwrap(), module, cards, now).unwrap()
        }

        fn due(&self, module: Option<&str>, now: i64) -> Vec<Card> {
            query_due_cards(&self.db.conn.lock().unwrap(), module, now).unwrap()
        }

        fn column<T: rusqlite::types::FromSql>(&self, sql: &str, id: &str) -> T {
            self.db
                .conn
                .lock()
                .unwrap()
                .query_one(sql, [id], |row| row.get(0))
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn basic(id: &str, front: &str, back: &str) -> CardContent {
        CardContent {
            id: id.into(),
            kind: "basic".into(),
            front: json!([{ "type": "text", "text": front }]),
            back: json!([{ "type": "text", "text": back }]),
        }
    }

    fn reviewed(due_at: i64, reps: i64) -> ReviewedCard {
        ReviewedCard {
            fsrs: FsrsState {
                due_at,
                stability: 3.9,
                stability_fast: 3.1,
                difficulty: 3.5,
                scheduled_days: 4.8,
                learning_step: 0,
                state: 2,
                schedule_status: "review".into(),
                last_review_at: Some(100),
            },
            reps,
            lapses: 0,
        }
    }

    fn log(rating: i64) -> ReviewLog {
        ReviewLog {
            before: FsrsState {
                due_at: 10,
                stability: 0.0,
                stability_fast: 0.0,
                difficulty: 0.0,
                scheduled_days: 0.0,
                learning_step: 0,
                state: 0,
                schedule_status: "new".into(),
                last_review_at: None,
            },
            rating,
            review_time: 100,
            duration_ms: Some(1200),
            fsrs_model: "fsrs-7".into(),
        }
    }

    fn review(f: &Fixture, id: &str, expected_reps: i64, due_at: i64) -> CommandResult<()> {
        save_review(
            &mut f.db.conn.lock().unwrap(),
            id,
            expected_reps,
            &reviewed(due_at, expected_reps + 1),
            &log(3),
        )
    }

    #[test]
    fn indexing_completeness_requires_a_conflict_free_snapshot_even_for_empty_notes() {
        let f = Fixture::new();
        let indexed = |id: &str| -> bool {
            f.db.conn
                .lock()
                .unwrap()
                .query_row(
                    "select exists(select 1 from card_indexed_modules where module_id = ?1)",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert!(!indexed("a"));
        f.sync("a", &[basic("shared", "Q", "A")], 10);
        assert!(indexed("a"));
        f.sync("b", &[], 10);
        assert!(indexed("b"));
        assert_eq!(f.sync("b", &[basic("shared", "Q", "A")], 20), ["shared"]);
        assert!(!indexed("b"));
        f.sync("b", &[basic("repaired", "Q", "A")], 30);
        assert!(indexed("b"));
    }

    #[test]
    fn new_cards_are_due_immediately_and_counted_per_module() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A"), basic("2", "Q2", "A2")], 10);
        f.sync("b", &[basic("3", "Q3", "A3")], 20);
        assert!(f.due(None, 5).is_empty());
        let due = f.due(None, 20);
        assert_eq!(
            due.iter().map(|card| card.id.as_str()).collect::<Vec<_>>(),
            ["1", "2", "3"]
        );
        assert_eq!(due[0].module_name, "Algebra");
        assert_eq!(due[0].front, json!([{ "type": "text", "text": "Q" }]));
        assert_eq!(due[0].fsrs.schedule_status, "new");
        assert_eq!(f.due(Some("b"), 20).len(), 1);
        assert_eq!(
            query_due_counts(&f.db.conn.lock().unwrap(), 20).unwrap(),
            vec![
                DueCount {
                    module_id: "a".into(),
                    count: 2
                },
                DueCount {
                    module_id: "b".into(),
                    count: 1
                },
            ]
        );
    }

    #[test]
    fn editing_content_keeps_the_schedule_and_history() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        review(&f, "1", 0, 5_000).unwrap();
        f.sync("a", &[basic("1", "Question", "Answer")], 20);

        let card = &f.due(None, 5_000)[0];
        assert_eq!(card.back, json!([{ "type": "text", "text": "Answer" }]));
        assert_eq!(card.fsrs, reviewed(5_000, 1).fsrs);
        assert_eq!(card.reps, 1);
        assert_eq!(card.fsrs_model.as_deref(), Some("fsrs-7"));
        let updated: i64 = f.column("select updated_at from cards where id = ?1", "1");
        assert_eq!(updated, 20);
        // An unchanged sync is not an edit.
        f.sync("a", &[basic("1", "Question", "Answer")], 30);
        let updated: i64 = f.column("select updated_at from cards where id = ?1", "1");
        assert_eq!(updated, 20);
    }

    #[test]
    fn missing_cards_are_soft_deleted_and_restored_with_their_state() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A"), basic("2", "Q2", "A2")], 10);
        review(&f, "1", 0, 50).unwrap();
        f.sync("b", &[basic("3", "Q3", "A3")], 10);

        f.sync("a", &[basic("2", "Q2", "A2")], 20);
        let deleted: Option<i64> = f.column("select deleted_at from cards where id = ?1", "1");
        assert_eq!(deleted, Some(20));
        assert_eq!(
            f.due(None, 100)
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["2", "3"],
            "a deleted card is not due, and other modules are untouched"
        );
        assert!(review(&f, "1", 1, 60).is_err());

        f.sync("a", &[basic("1", "Q", "A"), basic("2", "Q2", "A2")], 30);
        let due = f.due(None, 100);
        let restored = due.iter().find(|card| card.id == "1").unwrap();
        assert_eq!(restored.reps, 1);
        assert_eq!(restored.fsrs.due_at, 50);
        let logs: i64 = f.column("select count(*) from review_log where card_id = ?1", "1");
        assert_eq!(logs, 1);
    }

    #[test]
    fn a_card_live_in_another_module_is_reported_not_moved() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        assert_eq!(
            f.sync("b", &[basic("1", "Q", "A"), basic("2", "Q", "A")], 20),
            ["1"]
        );
        let module: String = f.column("select module_id from cards where id = ?1", "1");
        assert_eq!(module, "a");
        assert_eq!(f.due(Some("b"), 20).len(), 1);

        // Cut from one note and pasted into another: the history moves along.
        f.sync("a", &[], 30);
        assert!(f
            .sync("b", &[basic("1", "Q", "A"), basic("2", "Q", "A")], 40)
            .is_empty());
        let module: String = f.column("select module_id from cards where id = ?1", "1");
        assert_eq!(module, "b");
    }

    #[test]
    fn reviews_update_the_card_and_log_atomically_and_reject_stale_submissions() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        review(&f, "1", 0, 5_000).unwrap();
        // A second submission computed from the same pre-review card.
        let error = review(&f, "1", 0, 9_000).unwrap_err();
        assert!(error.contains("reviewed elsewhere"), "{error}");

        let due_at: i64 = f.column("select due_at from cards where id = ?1", "1");
        assert_eq!(due_at, 5_000);
        let row: (i64, i64, String, i64, Option<i64>) =
            f.db.conn
                .lock()
                .unwrap()
                .query_one(
                    "select rating, review_time, schedule_status, due_at, duration_ms
                 from review_log where card_id = '1'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .unwrap();
        assert_eq!(row, (3, 100, "new".into(), 10, Some(1200)));
        assert!(review(&f, "missing", 0, 1)
            .unwrap_err()
            .contains("no longer exists"));
    }

    #[test]
    fn deleting_a_module_removes_its_cards_and_reviews() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        f.sync("b", &[basic("2", "Q", "A")], 10);
        review(&f, "1", 0, 50).unwrap();
        review(&f, "2", 0, 50).unwrap();
        delete_module_data(&mut f.db.conn.lock().unwrap(), &f.dir.join("files"), "a").unwrap();

        let cards: i64 = f.column("select count(*) from cards where module_id = ?1", "a");
        let logs: i64 = f.column("select count(*) from review_log where card_id = ?1", "1");
        let other: i64 = f.column("select count(*) from review_log where card_id = ?1", "2");
        assert_eq!((cards, logs, other), (0, 0, 1));
    }
}

#[derive(serde::Serialize)]
pub(crate) struct UnindexedModule {
    id: String,
    name: String,
}

#[tauri::command(async)]
pub(crate) fn unindexed_card_modules(db: tauri::State<Db>) -> CommandResult<Vec<UnindexedModule>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare("select id, name from modules where id not in (select module_id from card_indexed_modules) order by name").map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UnindexedModule {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}
