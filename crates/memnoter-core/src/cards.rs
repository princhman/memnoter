// Flashcard storage. Cards are written in note text; the editor extracts them
// and syncs them here. Scheduling is computed in TypeScript with ts-fsrs, so
// this module only stores card content, the FSRS state and the review log.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};

use super::{db_err, CommandResult, Db};

pub fn migrate_flashcards(conn: &Connection) -> CommandResult<()> {
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
            -- JSON array of the heading titles above the card, outermost first.
            section TEXT NOT NULL DEFAULT '[]',
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
    .map_err(db_err)?;

    if crate::db::ensure_column(conn, "cards", "section", "TEXT NOT NULL DEFAULT '[]'")? {
        conn.execute("delete from card_indexed_modules", [])
            .map_err(db_err)?;
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
pub struct CardContent {
    id: String,
    kind: String,
    front: serde_json::Value,
    back: serde_json::Value,
    #[serde(default)]
    section: Vec<String>,
}

// The scheduling fields shared by a stored card and a review log row.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsState {
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
pub struct Card {
    id: String,
    module_id: String,
    module_name: String,
    // Review availability is separate from the unchanged FSRS due date.
    available_at: i64,
    section: Vec<String>,
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
pub struct ReviewedCard {
    #[serde(flatten)]
    fsrs: FsrsState,
    reps: i64,
    lapses: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLog {
    #[serde(flatten)]
    before: FsrsState,
    rating: i64,
    review_time: i64,
    duration_ms: Option<i64>,
    fsrs_model: String,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCount {
    module_id: String,
    count: i64,
    // Split like Anki: never reviewed, in (re)learning steps, and graduated.
    new: i64,
    learning: i64,
    review: i64,
    // Not due yet, but due before the day ends, split the same way.
    later_new: i64,
    later_learning: i64,
    later_review: i64,
}

// When a live card is next due and when it was last reviewed, for the info
// shown beside it in the note.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSchedule {
    created_at: i64,
    id: String,
    due_at: i64,
    last_review_at: Option<i64>,
    state: i64,
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
    let mut unavailable = Vec::new();
    {
        let mut upsert = tx
            .prepare(
                "insert into cards (id, module_id, kind, front, back, section, due_at, created_at, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?7, ?6, ?6, ?6)
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
                     section = excluded.section,
                     deleted_at = null
                 where cards.module_id = excluded.module_id or cards.deleted_at is not null",
            )
            .map_err(db_err)?;
        for card in cards {
            if card.kind == "occlusion" {
                let front_id =
                    crate::files::assets::card_image(&card.kind, &card.front, &card.back);
                let exists = front_id.is_some()
                    && tx
                        .query_row(
                            "select exists(select 1 from files where id = ?1)",
                            [front_id],
                            |r| r.get::<_, bool>(0),
                        )
                        .map_err(db_err)?;
                if !exists {
                    unavailable.push(card.id.clone());
                    continue;
                }
            }
            let changed = upsert
                .execute(params![
                    card.id,
                    module_id,
                    card.kind,
                    json_text(&card.front)?,
                    json_text(&card.back)?,
                    now,
                    serde_json::to_string(&card.section).map_err(db_err)?
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
            .filter(|card| !conflicts.contains(&card.id) && !unavailable.contains(&card.id))
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
    crate::search::invalidate_indexes(&tx, module_id)?;
    if conflicts.is_empty() {
        tx.execute(
            "insert or ignore into card_indexed_modules (module_id) values (?1)",
            [module_id],
        )
        .map_err(db_err)?;
    }
    // Cards first indexed here may have been reviewed on another device.
    crate::sync::apply_reviews(&tx, module_id)?;
    tx.commit().map_err(db_err)?;
    Ok(conflicts)
}

fn json_column(text: String) -> serde_json::Value {
    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
}

// A two-way sibling waits ten minutes after the other side's last review.
// Derived from card state so undo, synced reviews and reloads all agree, without
// changing either FSRS schedule or adding local burial state. Only exact basic
// forward/reverse pairs in the same note participate; clozes are independent.
const REVIEW_AVAILABILITY: &str = "with review_cards as (
    select c.*, coalesce(s.last_review_at + 600000, 0) as available_at,
           max(c.due_at, coalesce(s.last_review_at + 600000, 0)) as review_due_at
    from cards c left join cards s
      on c.kind = 'basic' and s.kind = 'basic'
     and s.module_id = c.module_id and s.deleted_at is null
     and s.id = case
         when instr(c.id, ':') = 0 then c.id || ':reverse'
         when substr(c.id, -8) = ':reverse' then substr(c.id, 1, length(c.id) - 8)
     end
)";

pub fn due_cards(
    db: &Db,
    module_id: Option<String>,
    now: i64,
    created_at_cutoff: Option<i64>,
) -> CommandResult<Vec<Card>> {
    let conn = db.lock()?;
    let module_id = module_id.as_deref();

    let mut stmt = conn
        .prepare(&format!(
            "{REVIEW_AVAILABILITY}
             select c.id, c.module_id, m.name, c.kind, c.front, c.back, c.due_at,
                    c.stability, c.stability_fast, c.difficulty, c.scheduled_days,
                    c.learning_step, c.state, c.schedule_status, c.last_review_at,
                    c.reps, c.lapses, c.fsrs_model, c.section, c.available_at
             from review_cards c join modules m on m.id = c.module_id
             where c.deleted_at is null and c.review_due_at <= ?1
               and (?2 is null or c.module_id = ?2)
               and (?3 is null or c.state != 0 or c.last_review_at is not null or c.created_at < ?3)
             order by c.review_due_at, c.id"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![now, module_id, created_at_cutoff], |row| {
            Ok(Card {
                id: row.get(0)?,
                module_id: row.get(1)?,
                module_name: row.get(2)?,
                available_at: row.get(19)?,
                section: serde_json::from_str(&row.get::<_, String>(18)?).unwrap_or_default(),
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

pub fn due_counts(
    db: &Db,
    now: i64,
    day_end: i64,
    created_at_cutoff: Option<i64>,
) -> CommandResult<Vec<DueCount>> {
    let conn = db.lock()?;

    let mut stmt = conn
        .prepare(&format!(
            // FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
            "{REVIEW_AVAILABILITY}
             select module_id, sum(review_due_at <= ?1), sum(review_due_at <= ?1 and state = 0),
                 sum(review_due_at <= ?1 and state in (1, 3)), sum(review_due_at <= ?1 and state = 2),
                 sum(review_due_at > ?1 and state = 0), sum(review_due_at > ?1 and state in (1, 3)),
                 sum(review_due_at > ?1 and state = 2)
             from review_cards
             where deleted_at is null and review_due_at <= max(?1, ?2)
               and (?3 is null or state != 0 or last_review_at is not null or created_at < ?3)
             group by module_id order by module_id"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![now, day_end, created_at_cutoff], |row| {
            Ok(DueCount {
                module_id: row.get(0)?,
                count: row.get(1)?,
                new: row.get(2)?,
                learning: row.get(3)?,
                review: row.get(4)?,
                later_new: row.get(5)?,
                later_learning: row.get(6)?,
                later_review: row.get(7)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

pub fn card_schedules(db: &Db, module_id: String) -> CommandResult<Vec<CardSchedule>> {
    let conn = db.lock()?;
    let module_id = module_id.as_str();

    let mut stmt = conn
        .prepare(
            "select id, due_at, last_review_at, state, created_at from cards
             where module_id = ?1 and deleted_at is null order by id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([module_id], |row| {
            Ok(CardSchedule {
                id: row.get(0)?,
                due_at: row.get(1)?,
                last_review_at: row.get(2)?,
                state: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

// Sets a card's scheduling state, only if its repetition count is still
// `expected_reps`: a stale or repeated write (a double key press, two windows)
// is rejected rather than applied twice.
fn write_card_state(
    tx: &rusqlite::Transaction,
    card_id: &str,
    expected_reps: i64,
    card: &ReviewedCard,
    fsrs_model: Option<&str>,
) -> CommandResult<()> {
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
                fsrs_model
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
    Ok(())
}

// Stores a review computed by ts-fsrs. `expected_reps` is the repetition count
// the review was computed from.
pub fn review_card(
    db: &Db,
    card_id: String,
    expected_reps: i64,
    card: ReviewedCard,
    log: ReviewLog,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    let card_id = card_id.as_str();
    let card = &card;
    let log = &log;

    let tx = conn.transaction().map_err(db_err)?;
    write_card_state(&tx, card_id, expected_reps, card, Some(&log.fsrs_model))?;
    let before = &log.before;
    tx.execute(
        "insert into review_log (card_id, rating, review_time, duration_ms, fsrs_model,
             state, schedule_status, due_at, last_review_at, stability, stability_fast,
             difficulty, scheduled_days, learning_step, sync_id)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, lower(hex(randomblob(16))))",
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
    let log_id = tx.last_insert_rowid();
    crate::sync::record_review(&tx, card_id, Some(log_id), None)?;
    tx.commit().map_err(db_err)
}

// Takes back a card's latest review, made at `review_time`: the card returns
// to `previous`, its state before that review, and the review leaves the log.
// `expected_reps` is the count that review left, so a card reviewed again
// since is not rolled back.
pub fn undo_review(
    db: &Db,
    card_id: String,
    expected_reps: i64,
    previous: ReviewedCard,
    previous_fsrs_model: Option<String>,
    review_time: i64,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    let card_id = card_id.as_str();
    let previous = &previous;
    let previous_fsrs_model = previous_fsrs_model.as_deref();

    let tx = conn.transaction().map_err(db_err)?;
    let removed: Option<Option<String>> = tx
        .query_row(
            "delete from review_log
             where id = (select max(id) from review_log where card_id = ?1)
               and review_time = ?2
             returning sync_id",
            params![card_id, review_time],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?;
    let Some(sync_id) = removed else {
        return Err("The review to undo is no longer the card's latest".into());
    };
    write_card_state(&tx, card_id, expected_reps, previous, previous_fsrs_model)?;
    crate::sync::record_review(&tx, card_id, None, sync_id.as_deref())?;
    tx.commit().map_err(db_err)
}

pub fn sync_cards(
    db: &Db,
    module_id: String,
    cards: Vec<CardContent>,
) -> CommandResult<Vec<String>> {
    let mut conn = db.lock()?;
    sync_module_cards(&mut conn, &module_id, &cards, Utc::now().timestamp_millis())
}

#[derive(serde::Serialize)]
pub struct UnindexedModule {
    id: String,
    name: String,
}

pub fn unindexed_card_modules(db: &Db) -> CommandResult<Vec<UnindexedModule>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{delete_module_data, Core};
    use serde_json::json;
    use uuid::Uuid;

    struct Fixture {
        dir: std::path::PathBuf,
        core: Core,
    }

    impl std::ops::Deref for Fixture {
        type Target = Core;
        fn deref(&self) -> &Core {
            &self.core
        }
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("notes-cards-{}", Uuid::new_v4()));
            let core = Core::open(&dir).unwrap();
            let db = &core.db;
            db.conn
                .lock()
                .unwrap()
                .execute_batch(
                    "insert into modules (id, name) values ('a', 'Algebra'), ('b', 'Biology');
                     insert into contents values ('a', X''), ('b', X'');",
                )
                .unwrap();
            Self { dir, core }
        }

        fn sync(&self, module: &str, cards: &[CardContent], now: i64) -> Vec<String> {
            sync_module_cards(&mut self.db.conn.lock().unwrap(), module, cards, now).unwrap()
        }

        fn due(&self, module: Option<&str>, now: i64) -> Vec<Card> {
            due_cards(&self.db, module.map(str::to_owned), now, None).unwrap()
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
            section: Vec::new(),
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

    fn undo(
        f: &Fixture,
        id: &str,
        expected_reps: i64,
        previous: &ReviewedCard,
        model: Option<&str>,
        time: i64,
    ) -> CommandResult<()> {
        undo_review(
            &f.db,
            id.into(),
            expected_reps,
            ReviewedCard {
                fsrs: previous.fsrs.clone(),
                reps: previous.reps,
                lapses: previous.lapses,
            },
            model.map(str::to_owned),
            time,
        )
    }

    fn review(f: &Fixture, id: &str, expected_reps: i64, due_at: i64) -> CommandResult<()> {
        review_card(
            &f.db,
            id.into(),
            expected_reps,
            reviewed(due_at, expected_reps + 1),
            log(3),
        )
    }

    #[test]
    fn created_today_cutoff_filters_new_cards_without_changing_schedules() {
        let f = Fixture::new();
        f.sync("a", &[basic("yesterday", "Q", "A")], 9);
        f.sync(
            "a",
            &[
                basic("yesterday", "Q", "A"),
                basic("today", "Q", "A"),
                basic("reviewed", "Q", "A"),
                basic("later", "Q", "A"),
            ],
            10,
        );
        review(&f, "reviewed", 0, 10).unwrap();
        let conn = f.db.conn.lock().unwrap();
        conn.execute("update cards set due_at = 15 where id = 'later'", [])
            .unwrap();
        drop(conn);
        let ids = |cutoff| {
            due_cards(&f.db, None, 20, cutoff)
                .unwrap()
                .into_iter()
                .map(|c| c.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(Some(10)), ["yesterday", "reviewed"]);
        assert_eq!(ids(None).len(), 4);
        let filtered = due_counts(&f.db, 12, 20, Some(10)).unwrap();
        assert_eq!(
            (
                filtered[0].count,
                filtered[0].new,
                filtered[0].review,
                filtered[0].later_new
            ),
            (2, 1, 1, 0)
        );
        let all = due_counts(&f.db, 12, 20, None).unwrap();
        assert_eq!((all[0].count, all[0].new, all[0].later_new), (3, 2, 1));
        assert_eq!(ids(Some(21)).len(), 4);
        assert_eq!(
            f.db.lock()
                .unwrap()
                .query_row("select due_at from cards where id = 'today'", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            10
        );
    }

    #[test]
    fn two_way_siblings_wait_ten_minutes_without_changing_fsrs_or_counts() {
        for (first, sibling) in [("block", "block:reverse"), ("block:reverse", "block")] {
            let f = Fixture::new();
            f.sync(
                "a",
                &[
                    basic("block", "Q", "A"),
                    basic("block:reverse", "A", "Q"),
                    basic("other", "Q2", "A2"),
                    basic("block:cloze", "C", "A"),
                ],
                10,
            );
            review(&f, first, 0, 900_000).unwrap();
            let ids = |now| {
                f.due(None, now)
                    .into_iter()
                    .map(|c| c.id)
                    .collect::<Vec<_>>()
            };
            assert_eq!(ids(100), ["block:cloze", "other"]);
            let counts = due_counts(&f.db, 100, 600_100, None).unwrap();
            assert_eq!((counts[0].count, counts[0].later_new), (2, 1));
            assert_eq!(
                due_counts(&f.db, 100, 600_099, None).unwrap()[0].later_new,
                0
            );
            assert!(!ids(600_099).contains(&sibling.to_string()));
            assert!(ids(600_100).contains(&sibling.to_string()));
            let card = f
                .due(None, 600_100)
                .into_iter()
                .find(|c| c.id == sibling)
                .unwrap();
            let payload = serde_json::to_value(card).unwrap();
            assert_eq!(payload["availableAt"], 600_100);
            assert_eq!(
                payload["dueAt"], 10,
                "the scheduler still receives the FSRS due date"
            );
            assert_eq!(
                f.column::<i64>("select due_at from cards where id = ?1", sibling),
                10
            );

            // Undo releases the sibling immediately, including after reload.
            let mut previous = reviewed(10, 0);
            previous.fsrs.last_review_at = None;
            previous.fsrs.state = 0;
            undo(&f, first, 1, &previous, None, 100).unwrap();
            assert_eq!(ids(100).len(), 4);

            // If only the sibling remains, wait rather than reveal it immediately.
            review(&f, first, 0, 900_000).unwrap();
            f.sync(
                "a",
                &[basic("block", "Q", "A"), basic("block:reverse", "A", "Q")],
                110,
            );
            assert!(ids(110).is_empty());
            assert_eq!(ids(600_100), [sibling]);
        }
    }

    #[test]
    fn removing_reverse_soft_deletes_only_reverse_and_restore_keeps_history() {
        let f = Fixture::new();
        let forward = basic("block", "Front", "Back");
        let reverse = basic("block:reverse", "Back", "Front");
        f.sync("a", &[forward, reverse], 10);
        review(&f, "block", 0, 10).unwrap();
        f.sync("a", &[basic("block", "Front", "Back")], 20);
        assert_eq!(f.due(None, 30).len(), 1);
        assert_eq!(
            f.column::<i64>(
                "select deleted_at from cards where id = ?1",
                "block:reverse"
            ),
            20
        );
        f.sync(
            "a",
            &[
                basic("block", "Front", "Back"),
                basic("block:reverse", "Back", "Front"),
            ],
            30,
        );
        assert_eq!(
            f.column::<i64>("select reps from cards where id = ?1", "block"),
            1
        );
        assert_eq!(
            f.column::<i64>(
                "select created_at from cards where id = ?1",
                "block:reverse"
            ),
            10
        );
        assert_eq!(f.due(None, 600_100).len(), 2);
    }

    #[test]
    fn occlusion_edit_restore_and_missing_asset_share_the_review_lifecycle() {
        let f = Fixture::new();
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "insert into files values ('asset','a','/synthetic/asset','image/png')",
                [],
            )
            .unwrap();
        let mut card = CardContent {
            id: "image:o:mask".into(),
            kind: "occlusion".into(),
            front: json!({"fileId":"asset","revealed":false}),
            back: json!({"fileId":"asset","revealed":true}),
            section: Vec::new(),
        };
        f.sync("a", std::slice::from_ref(&card), 10);
        review(&f, &card.id, 0, 500).unwrap();
        card.front["masks"] = json!([{"id":"mask","shape":"rectangle","x":0.1}]);
        f.sync("a", std::slice::from_ref(&card), 110);
        f.sync("a", &[], 120);
        assert!(f.due(None, 1000).is_empty());
        f.sync("a", std::slice::from_ref(&card), 130);
        let due = f.due(None, 1000);
        assert_eq!(due[0].reps, 1);
        assert_eq!(due[0].fsrs.due_at, 500);
        assert_eq!(due[0].front, card.front);
        f.db.conn
            .lock()
            .unwrap()
            .execute("delete from files where id = 'asset'", [])
            .unwrap();
        f.sync("a", &[card], 140);
        assert!(f.due(None, 1000).is_empty());
        assert_eq!(
            f.column::<i64>(
                "select count(*) from review_log where card_id = ?1",
                "image:o:mask"
            ),
            1
        );
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
    fn a_card_keeps_the_latest_section_it_was_synced_with() {
        let f = Fixture::new();
        let mut card = basic("1", "Q", "A");
        card.section = vec!["Logic".into(), "Quantifiers".into()];
        f.sync("a", std::slice::from_ref(&card), 10);
        assert_eq!(f.due(None, 10)[0].section, ["Logic", "Quantifiers"]);
        card.section = vec!["Proofs".into()];
        f.sync("a", &[card], 20);
        assert_eq!(f.due(None, 20)[0].section, ["Proofs"]);
    }

    #[test]
    fn adding_sections_checks_every_note_again() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        let conn = f.db.conn.lock().unwrap();
        // The database as it was before sections.
        conn.execute_batch("alter table cards drop column section;")
            .unwrap();
        migrate_flashcards(&conn).unwrap();
        let indexed: i64 = conn
            .query_row("select count(*) from card_indexed_modules", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(indexed, 0);
        drop(conn);
        assert_eq!(f.due(None, 10)[0].section, Vec::<String>::new());
        // Opening the migrated database again leaves the index alone.
        f.sync("a", &[basic("1", "Q", "A")], 20);
        migrate_flashcards(&f.db.conn.lock().unwrap()).unwrap();
        assert!(f.column::<bool>(
            "select exists(select 1 from card_indexed_modules where module_id = ?1)",
            "a"
        ));
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
        // A graduated card due again counts as review, not new.
        review(&f, "2", 0, 15).unwrap();
        assert_eq!(
            card_schedules(&f.db, "a".into()).unwrap(),
            vec![
                CardSchedule {
                    id: "1".into(),
                    due_at: 10,
                    last_review_at: None,
                    state: 0,
                    created_at: 10,
                },
                CardSchedule {
                    id: "2".into(),
                    due_at: 15,
                    last_review_at: Some(100),
                    state: 2,
                    created_at: 10,
                },
            ]
        );
        assert_eq!(
            due_counts(&f.db, 20, 20, None).unwrap(),
            vec![
                DueCount {
                    module_id: "a".into(),
                    count: 2,
                    new: 1,
                    learning: 0,
                    review: 1,
                    later_new: 0,
                    later_learning: 0,
                    later_review: 0,
                },
                DueCount {
                    module_id: "b".into(),
                    count: 1,
                    new: 1,
                    learning: 0,
                    review: 0,
                    later_new: 0,
                    later_learning: 0,
                    later_review: 0,
                },
            ]
        );
        // Before card 2 is due it counts only as later today, until the day ends.
        assert_eq!(
            due_counts(&f.db, 12, 15, None).unwrap()[0],
            DueCount {
                module_id: "a".into(),
                count: 1,
                new: 1,
                learning: 0,
                review: 0,
                later_new: 0,
                later_learning: 0,
                later_review: 1,
            }
        );
        assert_eq!(due_counts(&f.db, 12, 14, None).unwrap()[0].later_review, 0);
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
    fn undoing_a_review_restores_the_card_and_drops_its_log_entry() {
        let f = Fixture::new();
        f.sync("a", &[basic("1", "Q", "A")], 10);
        let before: (i64, i64, String) =
            f.db.conn
                .lock()
                .unwrap()
                .query_one(
                    "select due_at, reps, schedule_status from cards where id = '1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        review(&f, "1", 0, 5_000).unwrap();
        let mut previous = reviewed(before.0, before.1);
        previous.fsrs.schedule_status = before.2.clone();
        previous.fsrs.last_review_at = None;

        // Only the review that left the card at this count can be undone.
        let error = undo(&f, "1", 0, &previous, None, 100).unwrap_err();
        assert!(error.contains("reviewed elsewhere"), "{error}");
        let error = undo(&f, "1", 1, &previous, None, 99).unwrap_err();
        assert!(error.contains("no longer the card's latest"), "{error}");

        undo(&f, "1", 1, &previous, None, 100).unwrap();
        let after: (i64, i64, String) =
            f.db.conn
                .lock()
                .unwrap()
                .query_one(
                    "select due_at, reps, schedule_status from cards where id = '1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        assert_eq!(after, before);
        let logs: i64 = f.column("select count(*) from review_log where card_id = ?1", "1");
        assert_eq!(logs, 0);
        // Redo is the same review submitted again.
        review(&f, "1", 0, 5_000).unwrap();
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
