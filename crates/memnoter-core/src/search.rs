use crate::*;

#[derive(Debug, serde::Serialize)]
pub struct SearchResult {
    pub module_id: String,
    pub name: String,
    // The name and a short excerpt, with each match wrapped in
    // SNIPPET_START and SNIPPET_END.
    pub name_marked: String,
    pub snippet: String,
}
const SNIPPET_START: &str = "\u{2}";
const SNIPPET_END: &str = "\u{3}";
const MAX_QUERY_TERMS: usize = 16;

// Turns free text into an FTS5 query that cannot be a syntax error: every
// whitespace-separated term becomes a quoted string, so operators, quotes,
// parentheses and column filters are matched as text. Terms are ANDed, and the
// last one is a prefix so results follow typing. Terms without any letter or
// digit produce no tokens, so they are dropped rather than matching nothing.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .take(MAX_QUERY_TERMS)
        .map(|term| {
            let clean: String = term.chars().filter(|c| !c.is_control()).collect();
            format!("\"{}\"", clean.replace('"', "\"\""))
        })
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{}*", terms.join(" ")))
}

pub fn index_note_text(
    conn: &mut Connection,
    module_id: &str,
    body: &str,
    math: &str,
    version: i64,
    backfill: bool,
) -> CommandResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    // Backfill may have read its snapshot before a live index write. Never
    // replace an index already refreshed by this extractor (or a newer one).
    if backfill && tx.query_row(
        "select exists(select 1 from search_index_state where module_id = ?1 and version >= ?2)",
        params![module_id, version], |row| row.get::<_, bool>(0),
    ).map_err(db_err)? {
        return Ok(());
    }
    // A debounced save can land after the module was deleted; never revive it.
    let Some(name) = tx
        .query_row(
            "select name from modules where id = ?1",
            [module_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_err)?
    else {
        return Ok(());
    };
    tx.execute("delete from search_index where module_id = ?1", [module_id])
        .map_err(db_err)?;
    tx.execute(
        "insert into search_index (module_id, title, body, math) values (?1, ?2, ?3, ?4)",
        params![module_id, name, body, math],
    )
    .map_err(db_err)?;
    tx.execute(
        "insert into search_index_state (module_id, version) values (?1, ?2)
         on conflict(module_id) do update set version = excluded.version",
        params![module_id, version],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

pub fn search(conn: &Connection, query: &str, limit: i64) -> CommandResult<Vec<SearchResult>> {
    let Some(query) = fts_query(query) else {
        return Ok(Vec::new());
    };
    // bm25 weights follow the column order: module_id, title, body, math.
    let mut stmt = conn
        .prepare(
            "select module_id, title,
                 highlight(search_index, 1, ?3, ?4),
                 snippet(search_index, 2, ?3, ?4, '…', 12),
                 snippet(search_index, 3, ?3, ?4, '…', 12)
             from search_index
             where search_index match ?1
             order by bm25(search_index, 0.0, 10.0, 1.0, 1.0)
             limit ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(
            params![query, limit.clamp(1, 100), SNIPPET_START, SNIPPET_END],
            |row| {
                let body: String = row.get(3)?;
                let math: String = row.get(4)?;
                // Show the column that matched; a title-only match shows the
                // start of the note.
                let snippet = if !body.contains(SNIPPET_START) && math.contains(SNIPPET_START) {
                    math
                } else {
                    body
                };
                Ok(SearchResult {
                    module_id: row.get(0)?,
                    name: row.get(1)?,
                    name_marked: row.get(2)?,
                    snippet,
                })
            },
        )
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>>>().map_err(db_err)
}

pub fn index_note(
    db: &Db,
    module_id: String,
    body: String,
    math: String,
    version: i64,
    backfill: bool,
) -> CommandResult<()> {
    let mut conn = db.lock()?;
    index_note_text(&mut conn, &module_id, &body, &math, version, backfill)
}

pub fn unindexed_modules(db: &Db, version: i64) -> CommandResult<Vec<String>> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare(
            "select m.id from modules m
             left join search_index_state s on s.module_id = m.id
             where s.version is null or s.version < ?1",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([version], |row| row.get(0))
        .map_err(db_err)?;
    rows.collect::<Result<Vec<String>>>().map_err(db_err)
}

pub fn search_notes(
    db: &Db,
    query: String,
    limit: i64,
) -> CommandResult<Vec<SearchResult>> {
    let conn = db.lock()?;
    search(&conn, &query, limit)
}

