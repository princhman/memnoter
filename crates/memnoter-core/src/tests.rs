use super::*;

struct Fixture {
    dir: std::path::PathBuf,
    db: Db,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("notes-cleanup-{}", Uuid::new_v4()));
        let db = open_db(&dir).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "insert into modules (id, name) values ('note', 'Note'), ('other', 'Other');
                     insert into contents values ('note', X'0000'), ('other', X'0000');
                     insert into contents_updates values (7, 'note', X'0000', 0);",
            )
            .unwrap();
        }
        Self { dir, db }
    }

    fn file(&self, module: &str) -> String {
        self.file_with_id(module, Uuid::new_v4().to_string())
    }

    fn file_with_id(&self, module: &str, id: String) -> String {
        let path = self.dir.join("files").join(&id);
        std::fs::write(&path, b"image bytes").unwrap();
        self.db
            .conn
            .lock()
            .unwrap()
            .execute(
                "insert into files values (?1, ?2, ?3, 'image/png')",
                params![id, module, path.to_str().unwrap()],
            )
            .unwrap();
        id
    }

    fn cleanup(&self, ids: &[String], state: &[u8], update_id: i64) -> Vec<String> {
        cleanup_unused_files(
            &self.db.conn.lock().unwrap(),
            &self.dir.join("files"),
            "note",
            ids,
            state,
            update_id,
        )
        .unwrap()
    }

    fn row_exists(&self, id: &str) -> bool {
        self.db
            .conn
            .lock()
            .unwrap()
            .query_one(
                "select exists(select 1 from files where id = ?1)",
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn module_numbering_migration_defaults_off_and_preserves_each_module() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("create table modules(id TEXT PRIMARY KEY, name TEXT NOT NULL); insert into modules (id, name) values ('a', 'A'), ('b', 'B');").unwrap();
    migrate_module_numbering(&conn).unwrap();
    assert!(!conn
        .query_row(
            "select heading_numbering from modules where id='a'",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    conn.execute("update modules set heading_numbering=1 where id='a'", [])
        .unwrap();
    migrate_module_numbering(&conn).unwrap();
    assert!(conn
        .query_row(
            "select heading_numbering from modules where id='a'",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    assert!(!conn
        .query_row(
            "select heading_numbering from modules where id='b'",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
}

#[test]
fn deleting_module_removes_its_data_and_images_but_preserves_other_modules() {
    let f = Fixture::new();
    let image = f.file("note");
    let missing_image = f.file("note");
    let other_image = f.file("other");
    let files_dir = f.dir.join("files");
    std::fs::remove_file(files_dir.join(&missing_image)).unwrap();

    let mut conn = f.db.conn.lock().unwrap();
    delete_module_data(&mut conn, &files_dir, "note").unwrap();
    for table in ["contents", "contents_updates", "files"] {
        let count: i64 = conn
            .query_one(
                &format!("select count(*) from {table} where module_id = 'note'"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table} retained deleted module data");
    }
    let modules: Vec<String> = conn
        .prepare("select id from modules")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_>>()
        .unwrap();
    assert_eq!(modules, vec!["other"]);
    let other_state: Vec<u8> = conn
        .query_one(
            "select state from contents where module_id = 'other'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(other_state, vec![0, 0]);
    drop(conn);
    assert!(!files_dir.join(image).exists());
    assert!(files_dir.join(&other_image).exists());
    assert!(f.row_exists(&other_image));
}

#[test]
fn deleting_corrupt_note_skips_its_history_and_preserves_surviving_image_references() {
    use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
    for corrupt_snapshot in [true, false] {
        let f = Fixture::new();
        let shared = f.file("note");
        let unused = f.file("note");
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_xml_fragment("default");
        let mut txn = doc.transact_mut();
        let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
        image.insert_attribute(&mut txn, "fileId", shared.clone());
        let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        let mut conn = f.db.conn.lock().unwrap();
        conn.execute(
            "update contents set state = ?1 where module_id = 'other'",
            [state],
        )
        .unwrap();
        conn.execute_batch(if corrupt_snapshot {
            "update contents set state = X'FF' where module_id = 'note'"
        } else {
            "update contents_updates set bytes = X'FF' where module_id = 'note'"
        })
        .unwrap();

        delete_module_data(&mut conn, &f.dir.join("files"), "note").unwrap();
        let owner: String = conn
            .query_row(
                "select module_id from files where id = ?1",
                [&shared],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner, "other");
        let note_exists: bool = conn
            .query_row(
                "select exists(select 1 from modules where id = 'note')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!note_exists);
        drop(conn);
        assert!(f.row_exists(&shared));
        assert!(!f.row_exists(&unused));
        assert!(f.dir.join("files").join(shared).is_file());
        assert!(!f.dir.join("files").join(unused).exists());
    }
}

#[test]
fn cleanup_removes_only_requested_files_owned_by_the_note() {
    let f = Fixture::new();
    let unused = f.file("note");
    let retained = f.file("note");
    let other = f.file("other");
    assert_eq!(
        f.cleanup(&[unused.clone(), other.clone()], &[0, 0], 7),
        vec![unused.clone()]
    );
    assert!(!f.row_exists(&unused));
    assert!(!f.dir.join("files").join(&unused).exists());
    for id in [&retained, &other] {
        assert!(f.row_exists(id));
        assert_eq!(
            std::fs::read(f.dir.join("files").join(id)).unwrap(),
            b"image bytes"
        );
    }
    assert!(f.cleanup(&[unused], &[0, 0], 7).is_empty());
}

#[test]
fn card_assets_survive_cleanup_and_source_deletion_preserves_foreign_cards() {
    let f = Fixture::new();
    let id = f.file("note");
    let face = serde_json::json!({"version":1,"fileId":id,"imageId":"image","targetMaskId":"mask","masks":[]}).to_string();
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute(
            "insert into cards (id,module_id,kind,front,back,due_at,created_at,updated_at)
                values ('image:o:mask','other','occlusion',?1,?1,0,0,0)",
            [&face],
        )
        .unwrap();
    }
    assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
    assert!(f.row_exists(&id));
    f.db.conn
        .lock()
        .unwrap()
        .execute("update cards set deleted_at = 1", [])
        .unwrap();
    assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
    f.db.conn
        .lock()
        .unwrap()
        .execute("update cards set deleted_at = null", [])
        .unwrap();
    delete_module_data(&mut f.db.conn.lock().unwrap(), &f.dir.join("files"), "note").unwrap();
    assert!(f.row_exists(&id));
    assert!(f.dir.join("files").join(id).exists());
    let retired: bool =
        f.db.conn
            .lock()
            .unwrap()
            .query_one(
                "select deleted_at is not null from cards where id = 'image:o:mask'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert!(!retired);
}

#[test]
fn unopened_plain_copy_survives_owner_cleanup_after_restart() {
    let f = Fixture::new();
    // Real Yjs bytes guard the JS/Rust storage protocol, including nested
    // inline masked images and an ordinary image with no card face.
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../apps/shared-ui/tests/fixtures/shared-images-yjs.json"
    ))
    .unwrap();
    let id = f.file_with_id("note", fixture["fileId"].as_str().unwrap().to_owned());
    let state: Vec<u8> = serde_json::from_value(fixture["state"].clone()).unwrap();
    let updates: Vec<Vec<u8>> = serde_json::from_value(fixture["updates"].clone()).unwrap();
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute(
            "update contents set state = ?1 where module_id = 'other'",
            [state],
        )
        .unwrap();
        for (i, bytes) in updates.iter().enumerate() {
            conn.execute(
                "insert into contents_updates values (?1, 'other', ?2, 0)",
                params![8 + i as i64, bytes],
            )
            .unwrap();
        }
    }
    // Reopen storage: no React document or card face has ever indexed B.
    let restarted = open_db(&f.dir).unwrap();
    assert!(cleanup_unused_files(
        &restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "note",
        std::slice::from_ref(&id),
        &[0, 0],
        7
    )
    .unwrap()
    .is_empty());
    assert!(f.dir.join("files").join(&id).is_file());
    assert!(f.row_exists(&id));
    delete_module_data(
        &mut restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "note",
    )
    .unwrap();
    assert!(f.row_exists(&id));
    assert!(f.dir.join("files").join(&id).is_file());
    delete_module_data(
        &mut restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "other",
    )
    .unwrap();
    assert!(!f.row_exists(&id));
    assert!(!f.dir.join("files").join(&id).exists());
}

#[test]
fn copied_image_lease_survives_removal_compaction_and_restart() {
    use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
    let f = Fixture::new();
    let id = f.file("note");
    let doc = yrs::Doc::new();
    let root = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("inlineImage"));
    image.insert_attribute(&mut txn, "fileId", id.clone());
    let inserted = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    root.remove_range(&mut doc.transact_mut(), 0, 1);
    let removed = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    {
        let mut conn = f.db.conn.lock().unwrap();
        conn.execute(
            "insert into contents_updates values (8, 'other', ?1, 0)",
            [&inserted],
        )
        .unwrap();
        conn.execute(
            "insert into contents_updates values (9, 'other', ?1, 0)",
            [&removed],
        )
        .unwrap();
        compact_content(&mut conn, "other", &removed, 9).unwrap();
        let pending: i64 = conn
            .query_row(
                "select count(*) from contents_updates where module_id='other'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0);
    }
    let restarted = open_db(&f.dir).unwrap();
    assert!(cleanup_unused_files(
        &restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "note",
        std::slice::from_ref(&id),
        &[0, 0],
        7
    )
    .unwrap()
    .is_empty());
    // The persisted destination tree is empty, but its undo lease survives.
    delete_module_data(
        &mut restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "note",
    )
    .unwrap();
    assert_eq!(
        std::fs::read(f.dir.join("files").join(&id)).unwrap(),
        b"image bytes"
    );
    delete_module_data(
        &mut restarted.conn.lock().unwrap(),
        &f.dir.join("files"),
        "other",
    )
    .unwrap();
    assert!(!f.row_exists(&id));
}

#[test]
fn reversed_image_updates_cannot_authorize_cleanup_or_compaction() {
    use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
    let f = Fixture::new();
    let id = f.file("note");
    let doc = yrs::Doc::new();
    let root = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
    image.insert_attribute(&mut txn, "fileId", id.clone());
    let inserted = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    let mut txn = doc.transact_mut();
    root.remove_range(&mut txn, 0, 1);
    let removal = txn.encode_update_v1();
    let final_state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    let mut conn = f.db.conn.lock().unwrap();
    conn.execute(
        "insert into contents_updates values (8, 'other', ?1, 0)",
        [&removal],
    )
    .unwrap();
    conn.execute(
        "insert into contents_updates values (9, 'other', ?1, 0)",
        [&inserted],
    )
    .unwrap();
    assert!(cleanup_unused_files(
        &conn,
        &f.dir.join("files"),
        "note",
        std::slice::from_ref(&id),
        &[0, 0],
        7
    )
    .is_err());
    assert!(compact_content(&mut conn, "other", &final_state, 9).is_err());
    assert!(delete_module_data(&mut conn, &f.dir.join("files"), "note").is_err());
    assert!(f.dir.join("files").join(&id).is_file());
}

#[test]
fn invalid_or_incomplete_foreign_notes_cannot_authorize_destruction() {
    use yrs::{ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment};
    let f = Fixture::new();
    let id = f.file("note");
    let doc = yrs::Doc::new();
    let root = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
    let before = txn.state_vector();
    image.insert_attribute(&mut txn, "fileId", id.clone());
    let partial = txn.encode_state_as_update_v1(&before);
    for bytes in [vec![255], partial] {
        let mut conn = f.db.conn.lock().unwrap();
        conn.execute(
            "update contents set state = ?1 where module_id='other'",
            [bytes],
        )
        .unwrap();
        assert!(cleanup_unused_files(
            &conn,
            &f.dir.join("files"),
            "note",
            std::slice::from_ref(&id),
            &[0, 0],
            7
        )
        .is_err());
        assert!(delete_module_data(&mut conn, &f.dir.join("files"), "note").is_err());
        assert!(f.dir.join("files").join(&id).is_file());
    }
    assert!(f.row_exists(&id));
}

#[test]
fn stale_snapshots_never_remove_files() {
    let f = Fixture::new();
    let id = f.file("note");
    for (state, update_id) in [(vec![0], 7), (vec![0, 0], 6)] {
        assert!(f
            .cleanup(std::slice::from_ref(&id), &state, update_id)
            .is_empty());
        assert!(f.row_exists(&id));
        assert!(f.dir.join("files").join(&id).exists());
    }
}

#[test]
fn failed_removals_remain_retryable_and_missing_files_are_cleaned_up() {
    let f = Fixture::new();
    let id = f.file("note");
    let path = f.dir.join("files").join(&id);
    std::fs::remove_file(&path).unwrap();
    // A directory at the file path reliably fails remove_file, even as root.
    std::fs::create_dir(&path).unwrap();
    assert!(f.cleanup(std::slice::from_ref(&id), &[0, 0], 7).is_empty());
    assert!(f.row_exists(&id));
    std::fs::remove_dir(&path).unwrap();
    assert_eq!(
        f.cleanup(std::slice::from_ref(&id), &[0, 0], 7),
        vec![id.clone()]
    );
    assert!(!f.row_exists(&id));
}

fn search_ids(conn: &Connection, query: &str) -> Vec<String> {
    search(conn, query, 20)
        .unwrap()
        .into_iter()
        .map(|result| result.module_id)
        .collect()
}

#[test]
fn search_query_quotes_terms_and_prefixes_the_last() {
    assert_eq!(fts_query("foo bar").as_deref(), Some("\"foo\" \"bar\"*"));
    assert_eq!(
        fts_query(r#"say "hi""#).as_deref(),
        Some(r#""say" """hi"""*"#)
    );
    assert_eq!(fts_query("  \t\n "), None);
    assert_eq!(fts_query(r#"" - ( ) * ^ :"#), None);
}

#[test]
fn search_ranks_titles_first_and_marks_matches() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    index_note_text(&mut conn, "note", "about the integral sign", "", 1, false).unwrap();
    index_note_text(
        &mut conn,
        "other",
        "nothing here",
        r"\int_0^1 f(x)\,dx",
        1,
        false,
    )
    .unwrap();
    conn.execute(
        "update search_index set title = 'Integrals' where module_id = 'other'",
        [],
    )
    .unwrap();

    let results = search(&conn, "integ", 10).unwrap();
    let ids: Vec<_> = results.iter().map(|r| r.module_id.as_str()).collect();
    assert_eq!(ids, ["other", "note"]);
    assert_eq!(results[0].name_marked, "\u{2}Integrals\u{3}");
    assert!(results[1].snippet.contains("\u{2}integral\u{3}"));

    // LaTeX source is searchable, and the snippet comes from the math column.
    let results = search(&conn, r"\int_0", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].snippet, "\\\u{2}int_0\u{3}^1 f(x)\\,dx");
    // Every term must match.
    assert_eq!(search_ids(&conn, "integral nothing"), Vec::<String>::new());
    // Diacritics and case are folded.
    assert_eq!(search_ids(&conn, "ÍNTEGRAL SÍGN"), ["note"]);
}

#[test]
fn search_never_fails_on_fts_syntax() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    index_note_text(
        &mut conn,
        "note",
        "and or not near title body",
        "",
        1,
        false,
    )
    .unwrap();
    for query in [
        "\"",
        "\"\"",
        "-",
        "-foo",
        "AND",
        "foo AND",
        "OR NOT",
        "(",
        ")",
        "(foo",
        "*",
        "foo*",
        "^",
        "title:",
        "title:foo",
        "NEAR(a b)",
        "{title body}: x",
        "a + b",
        "'",
        "\\",
        "\u{0}",
        "😀",
        "a\"b",
        "and",
        "not",
        "x OR",
        "",
    ] {
        assert!(search(&conn, query, 10).is_ok(), "query {query:?} failed");
    }
    assert_eq!(search_ids(&conn, "AND"), ["note"]);
    assert_eq!(search_ids(&conn, "near"), ["note"]);
    // A column filter is literal text, not a filter.
    assert_eq!(search_ids(&conn, "title:"), ["note"]);
}

#[test]
fn search_index_follows_module_lifecycle() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    // Modules that existed before the index are searchable by title once
    // the app restarts.
    assert_eq!(search_ids(&conn, "Note"), Vec::<String>::new());
    migrate_search(&conn).unwrap();
    migrate_search(&conn).unwrap();
    assert_eq!(search_ids(&conn, "Note"), ["note"]);

    index_note_text(&mut conn, "note", "first", "", 1, false).unwrap();
    index_note_text(&mut conn, "note", "second", "", 2, false).unwrap();
    assert_eq!(search_ids(&conn, "first"), Vec::<String>::new());
    assert_eq!(search_ids(&conn, "second"), ["note"]);
    // A delayed backfill read must not replace a newer live index write.
    index_note_text(&mut conn, "note", "stale", "", 2, true).unwrap();
    assert_eq!(search_ids(&conn, "second"), ["note"]);
    assert!(search_ids(&conn, "stale").is_empty());
    // An extractor upgrade can still backfill an older index.
    index_note_text(&mut conn, "note", "second upgraded", "", 3, true).unwrap();
    assert_eq!(search_ids(&conn, "upgraded"), ["note"]);
    let rows: i64 = conn
        .query_one(
            "select count(*) from search_index where module_id = 'note'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);

    delete_module_data(&mut conn, &f.dir.join("files"), "note").unwrap();
    assert_eq!(search_ids(&conn, "second"), Vec::<String>::new());
    let states: i64 = conn
        .query_one("select count(*) from search_index_state", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(states, 0);

    // A late save for a deleted module must not bring it back.
    index_note_text(&mut conn, "note", "revived", "", 1, false).unwrap();
    assert_eq!(search_ids(&conn, "revived"), Vec::<String>::new());
}

fn compacted_test_state() -> Vec<u8> {
    use yrs::{ReadTxn, Text, Transact};
    let doc = yrs::Doc::new();
    doc.get_or_insert_text("test")
        .insert(&mut doc.transact_mut(), 0, "saved");
    let state = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    state
}

#[test]
fn compaction_writes_state_and_drops_updates_together() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    conn.execute_batch("insert into contents_updates values (8, 'note', X'0000', 0);")
        .unwrap();
    let snapshot = compacted_test_state();
    compact_content(&mut conn, "note", &snapshot, 7).unwrap();
    let content = read_content(&conn, "note").unwrap();
    assert_eq!(content.state, snapshot);
    assert_eq!(
        content
            .updates
            .iter()
            .map(|update| update.id)
            .collect::<Vec<_>>(),
        vec![8]
    );
}

#[test]
fn legacy_update_id_migration_preserves_rows_and_their_high_watermark() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
            create table modules (id TEXT PRIMARY KEY);
            insert into modules (id) values ('note');
            create table contents_updates (id INTEGER PRIMARY KEY, module_id TEXT NOT NULL,
                bytes BLOB NOT NULL, created_at INTEGER NOT NULL,
                FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE);
            insert into contents_updates values (300, 'note', X'0102', 42);",
    )
    .unwrap();
    migrate_update_ids(&conn).unwrap();
    migrate_update_ids(&conn).unwrap();
    let row: (i64, Vec<u8>, i64) = conn
        .query_row(
            "select id, bytes, created_at from contents_updates",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, (300, vec![1, 2], 42));
    conn.execute("delete from contents_updates", []).unwrap();
    conn.execute(
        "insert into contents_updates (module_id, bytes, created_at) values ('note', X'03', 43)",
        [],
    )
    .unwrap();
    assert_eq!(conn.last_insert_rowid(), 301);
    conn.execute("delete from modules where id = 'note'", [])
        .unwrap();
    assert_eq!(
        conn.query_row("select count(*) from contents_updates", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn stale_compaction_watermark_cannot_delete_a_later_update() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    // A stale read can retain the old watermark after its rows are folded.
    compact_content(&mut conn, "note", &compacted_test_state(), 7).unwrap();
    conn.execute(
        "insert into contents_updates (module_id, bytes, created_at) values ('note', X'0000', 0)",
        [],
    )
    .unwrap();
    compact_content(&mut conn, "note", &compacted_test_state(), 7).unwrap();
    let content = read_content(&conn, "note").unwrap();
    assert_eq!(content.updates.len(), 1);
    assert_eq!(content.updates[0].bytes, vec![0, 0]);
    assert!(content.updates[0].id > 7);
}

#[test]
fn failed_compaction_leaves_content_unchanged() {
    let f = Fixture::new();
    let mut conn = f.db.conn.lock().unwrap();
    let before = serde_json::to_value(read_content(&conn, "note").unwrap()).unwrap();
    // Fail the second statement, after the state has already been written.
    conn.execute_batch(
        "create temp trigger fail_delete before delete on contents_updates
             begin select raise(abort, 'disk full'); end;",
    )
    .unwrap();
    assert!(
        compact_content(&mut conn, "note", &compacted_test_state(), 7)
            .unwrap_err()
            .contains("disk full")
    );
    conn.execute_batch("drop trigger fail_delete;").unwrap();
    let after = serde_json::to_value(read_content(&conn, "note").unwrap()).unwrap();
    assert_eq!(after, before);
    assert_eq!(after["state"], serde_json::json!([0, 0]));
}

#[test]
fn legacy_data_is_copied_with_rewritten_paths_and_left_intact() {
    let root = std::env::temp_dir().join(format!("notes-migrate-{}", Uuid::new_v4()));
    let legacy = Fixture {
        dir: root.join(LEGACY_IDENTIFIER),
        db: open_db(&root.join(LEGACY_IDENTIFIER)).unwrap(),
    };
    legacy
        .db
        .conn
        .lock()
        .unwrap()
        .execute_batch("insert into modules (id, name) values ('note', 'Note');")
        .unwrap();
    // Keep the legacy connection open so its writes are still in the WAL.
    let id = legacy.file("note");

    let app_dir = root.join("com.vladyslavnalyvaiko.memnoter");
    migrate_legacy_data(&app_dir).unwrap();

    let db = open_db(&app_dir).unwrap();
    let path: String = db
        .conn
        .lock()
        .unwrap()
        .query_one("select path from files where id = ?1", [&id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(Path::new(&path), app_dir.join("files").join(&id));
    assert_eq!(std::fs::read(&path).unwrap(), b"image bytes");
    assert!(legacy.dir.join("files").join(&id).exists());
    assert!(!root
        .join("com.vladyslavnalyvaiko.memnoter.migrating")
        .exists());

    // Already migrated: a second run must not overwrite newer data.
    db.conn
        .lock()
        .unwrap()
        .execute("delete from files", [])
        .unwrap();
    migrate_legacy_data(&app_dir).unwrap();
    let count: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_one("select count(*) from files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn images_survive_moving_the_data_directory() {
    let dir = std::env::temp_dir().join(format!("notes-move-{}", Uuid::new_v4()));
    let moved = dir.with_extension("moved");
    let db = open_db(&dir).unwrap();
    let module = create_module(&db, "Images".into()).unwrap();
    let image = save_file(
        &dir,
        &db,
        module.clone(),
        b"image bytes".to_vec(),
        "image/png".into(),
    )
    .unwrap();
    drop(db);
    std::fs::rename(&dir, &moved).unwrap();
    // Reopen twice to exercise idempotence as well as old absolute receipts.
    drop(open_db(&moved).unwrap());
    let db = open_db(&moved).unwrap();
    let contents =
        serde_json::to_value(read_file(&moved, &db, module.clone(), image.id.clone()).unwrap())
            .unwrap();
    assert_eq!(
        contents["bytes"],
        serde_json::json!(b"image bytes".to_vec())
    );
    assert_eq!(
        resolve_card_image(&moved, &db, image.id.clone()).unwrap(),
        moved.join("files").join(&image.id).to_str().unwrap()
    );
    let content = serde_json::to_value(get_content(&db, module.clone()).unwrap()).unwrap();
    assert_eq!(
        content["files"][0]["path"],
        moved.join("files").join(&image.id).to_str().unwrap()
    );
    delete_module(&moved, &db, module).unwrap();
    assert!(!moved.join("files").join(image.id).exists());
    drop(db);
    std::fs::remove_dir_all(moved).unwrap();
}

#[test]
fn image_path_traversal_cannot_escape_managed_storage() {
    let f = Fixture::new();
    let outside = f.dir.join("outside");
    std::fs::write(&outside, b"private").unwrap();
    for id in ["../outside", "/tmp/outside"] {
        f.db.lock()
            .unwrap()
            .execute(
                "insert into files values (?1, 'note', ?2, 'image/png')",
                params![id, outside.to_str().unwrap()],
            )
            .unwrap();
        drop(open_db(&f.dir).unwrap());
        assert!(read_file(&f.dir, &f.db, "note".into(), id.into()).is_err());
        assert!(resolve_card_image(&f.dir, &f.db, id.into()).is_err());
        assert!(delete_module(&f.dir, &f.db, "note".into()).is_err());
        f.db.lock()
            .unwrap()
            .execute("delete from files where id=?1", [id])
            .unwrap();
    }
    assert_eq!(std::fs::read(outside).unwrap(), b"private");
}
