//! Cards' schedules and review logs, in the terms the converter replays.
use super::{AnkiCard, AnkiReview, CardKind};
use crate::CommandResult;
use rusqlite::Connection;
use std::collections::HashMap;

pub struct RawCard {
    pub id: i64,
    pub nid: i64,
    pub ord: i64,
    /// The deck the card belongs to, not the filtered deck it is borrowed by.
    pub did: i64,
    kind: i64,
    queue: i64,
    due: i64,
    interval: i64,
    factor: i64,
    reps: i64,
    lapses: i64,
}

fn db_err(error: rusqlite::Error) -> String {
    format!("The Anki collection could not be read: {error}")
}

/// Every card, ordered by note and template, and the review log by card.
pub fn read(
    conn: &Connection,
) -> CommandResult<(Vec<RawCard>, HashMap<i64, Vec<AnkiReview>>, i64)> {
    // Review dates count from creation day; rollover/creationOffset may shift this by hours.
    let created: i64 = conn
        .query_row("select crt from col", [], |row| row.get(0))
        .unwrap_or(0);
    let cards = conn
        .prepare(
            "select id, nid, ord, case when odid != 0 then odid else did end,
                    type, queue, case when odid != 0 then odue else due end,
                    ivl, factor, reps, lapses
             from cards order by nid, ord",
        )
        .map_err(db_err)?
        .query_map([], |row| {
            Ok(RawCard {
                id: row.get(0)?,
                nid: row.get(1)?,
                ord: row.get(2)?,
                did: row.get(3)?,
                kind: row.get(4)?,
                queue: row.get(5)?,
                due: row.get(6)?,
                interval: row.get(7)?,
                factor: row.get(8)?,
                reps: row.get(9)?,
                lapses: row.get(10)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    let mut reviews: HashMap<i64, Vec<AnkiReview>> = HashMap::new();
    // Types 3 (filtered-deck previews) and 4 (manual changes) are not answers.
    let rows = conn
        .prepare("select cid, id, ease from revlog where ease between 1 and 4 and type in (0, 1, 2) order by cid, id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        // A package exported without history has no log.
        .unwrap_or_default();
    for (cid, time, rating) in rows {
        reviews
            .entry(cid)
            .or_default()
            .push(AnkiReview { time, rating });
    }
    Ok((cards, reviews, created))
}

impl RawCard {
    pub fn into_card(self, created: i64, reviews: &mut HashMap<i64, Vec<AnkiReview>>) -> AnkiCard {
        let kind = match self.kind {
            1 => CardKind::Learning,
            2 => CardKind::Review,
            3 => CardKind::Relearning,
            _ => CardKind::New,
        };
        // Learning cards are due at a time in seconds; others on a day number.
        let due = match (kind, self.queue) {
            (CardKind::New, _) => None,
            (_, 1 | 4) => Some(self.due * 1000),
            _ => Some((created + self.due * 86_400) * 1000),
        };
        AnkiCard {
            ord: self.ord,
            mask: None,
            kind,
            suspended: self.queue == -1,
            due,
            // A negative interval counts seconds.
            interval_days: if self.interval < 0 {
                -self.interval as f64 / 86_400.0
            } else {
                self.interval as f64
            },
            ease: self.factor as f64 / 1000.0,
            reps: self.reps,
            lapses: self.lapses,
            reviews: reviews.remove(&self.id).unwrap_or_default(),
        }
    }
}
