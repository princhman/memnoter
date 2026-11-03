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

    // Cards stored before sections existed: add the column, and check every
    // note again so each card gets its section.
    let has_section = conn
        .prepare("select 1 from pragma_table_info('cards') where name = 'section'")
        .and_then(|mut stmt| stmt.exists([]))
        .map_err(db_err)?;
    if !has_section {
        conn.execute_batch(
            "alter table cards add column section TEXT NOT NULL DEFAULT '[]';
             delete from card_indexed_modules;",
        )
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
                let front_id = card.front.get("fileId").and_then(|v| v.as_str());
                let back_id = card.back.get("fileId").and_then(|v| v.as_str());
                let exists = front_id.is_some()
                    && front_id == back_id
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
                    c.reps, c.lapses, c.fsrs_model, c.section
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

fn query_due_counts(conn: &Connection, now: i64, day_end: i64) -> CommandResult<Vec<DueCount>> {
    let mut stmt = conn
        .prepare(
            // FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
            "select module_id, sum(due_at <= ?1), sum(due_at <= ?1 and state = 0),
                 sum(due_at <= ?1 and state in (1, 3)), sum(due_at <= ?1 and state = 2),
                 sum(due_at > ?1 and state = 0), sum(due_at > ?1 and state in (1, 3)),
                 sum(due_at > ?1 and state = 2)
             from cards
             where deleted_at is null and due_at <= max(?1, ?2)
             group by module_id order by module_id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([now, day_end], |row| {
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

fn query_card_schedules(conn: &Connection, module_id: &str) -> CommandResult<Vec<CardSchedule>> {
    let mut stmt = conn
        .prepare(
            "select id, due_at, last_review_at, state from cards
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
fn save_review(
    conn: &mut Connection,
    card_id: &str,
    expected_reps: i64,
    card: &ReviewedCard,
    log: &ReviewLog,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    write_card_state(&tx, card_id, expected_reps, card, Some(&log.fsrs_model))?;
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

// Takes back a card's latest review, made at `review_time`: the card returns
// to `previous`, its state before that review, and the review leaves the log.
// `expected_reps` is the count that review left, so a card reviewed again
// since is not rolled back.
fn undo_last_review(
    conn: &mut Connection,
    card_id: &str,
    expected_reps: i64,
    previous: &ReviewedCard,
    previous_fsrs_model: Option<&str>,
    review_time: i64,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let removed = tx
        .execute(
            "delete from review_log
             where id = (select max(id) from review_log where card_id = ?1)
               and review_time = ?2",
            params![card_id, review_time],
        )
        .map_err(db_err)?;
    if removed == 0 {
        return Err("The review to undo is no longer the card's latest".into());
    }
    write_card_state(&tx, card_id, expected_reps, previous, previous_fsrs_model)?;
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

pub fn due_cards(
    db: &Db,
    module_id: Option<String>,
    now: i64,
) -> CommandResult<Vec<Card>> {
    let conn = db.lock()?;
    query_due_cards(&conn, module_id.as_deref(), now)
}

pub fn card_schedules(
    db: &Db,
    module_id: String,
) -> CommandResult<Vec<CardSchedule>> {
    let conn = db.lock()?;
    query_card_schedules(&conn, &module_id)
}

pub fn due_counts(
    db: &Db,
    now: i64,
    day_end: i64,
) -> CommandResult<Vec<DueCount>> {
    let conn = db.lock()?;
    query_due_counts(&conn, now, day_end)
}

pub fn review_card(
    db: &Db,
    card_id: String,
    expected_reps: i64,
    card: ReviewedCard,
    log: ReviewLog,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    save_review(&mut conn, &card_id, expected_reps, &card, &log)
}

pub fn undo_review(
    db: &Db,
    card_id: String,
    expected_reps: i64,
    previous: ReviewedCard,
    previous_fsrs_model: Option<String>,
    review_time: i64,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    undo_last_review(
        &mut conn,
        &card_id,
        expected_reps,
        &previous,
        previous_fsrs_model.as_deref(),
        review_time,
    )
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
