use super::*;
use rusqlite::Connection;
use std::io::Write;
use std::path::PathBuf;

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn temp() -> Temp {
    let dir = std::env::temp_dir().join(format!("memnoter-anki-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Temp(dir)
}

const SEP: char = '\x1f';
const ENHANCED_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
 <g><title>Masks</title>
  <rect id="set1-ao-1" height="100" width="200" y="40" x="80" fill="#FF7E7E"/>
  <ellipse id="set1-ao-2" cx="400" cy="200" rx="40" ry="20"/>
  <polygon id="set1-ao-3" points="0,0 400,0 400,200"/>
  <rect id="set1-ao-9" height="10" width="10" y="0" x="0"/>
 </g></svg>"##;

/// (id, notetype id, fields, [(card ord, deck id)])
type Note = (i64, i64, Vec<&'static str>, Vec<(i64, i64)>);

fn write_cards(conn: &Connection, notes: &[Note]) {
    conn.execute_batch(
        "create table notes (id integer primary key, mid integer, flds text, tags text);
         create table cards (id integer primary key, nid integer, did integer, ord integer, odid integer default 0, odue integer default 0, type integer default 0, queue integer default 0, due integer default 0, ivl integer default 0, factor integer default 2500, reps integer default 0, lapses integer default 0); create table revlog(id integer, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);",
    )
    .unwrap();
    let mut card = 1000;
    for (id, mid, fields, cards) in notes {
        conn.execute(
            "insert into notes (id, mid, flds, tags) values (?1, ?2, ?3, '')",
            rusqlite::params![id, mid, fields.join(&SEP.to_string())],
        )
        .unwrap();
        for (ord, did) in cards {
            card += 1;
            conn.execute(
                "insert into cards (id, nid, did, ord) values (?1, ?2, ?3, ?4)",
                rusqlite::params![card, id, did, ord],
            )
            .unwrap();
        }
    }
}

fn legacy_db(path: &std::path::Path, notes: &[Note]) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("create table col (decks text, models text, crt integer default 1000);")
        .unwrap();
    let decks = serde_json::json!({
        "1": {"id": 1, "name": "Default", "dyn": 0},
        "10": {"id": 10, "name": "Course", "dyn": 0},
        "11": {"id": 11, "name": "Course::Maths", "dyn": 0},
        "12": {"id": 12, "name": "Filtered", "dyn": 1},
    });
    let field = |name: &str, ord: i64| serde_json::json!({"name": name, "ord": ord});
    let models = serde_json::json!({
        "100": {"id": 100, "name": "Basic", "type": 0, "flds": [field("Front", 0), field("Back", 1)], "tmpls": [{}]},
        "101": {"id": 101, "name": "Basic (and reversed card)", "type": 0, "flds": [field("Front", 0), field("Back", 1)], "tmpls": [{}, {}]},
        "102": {"id": 102, "name": "Cloze", "type": 1, "flds": [field("Text", 0), field("Back Extra", 1)], "tmpls": [{}]},
        "103": {"id": 103, "name": "Image Occlusion Enhanced", "type": 0, "tmpls": [{}], "flds": [
            field("ID (hidden)", 0), field("Header", 1), field("Image", 2), field("Question Mask", 3), field("Footer", 4),
            field("Remarks", 5), field("Sources", 6), field("Extra 1", 7), field("Extra 2", 8), field("Answer Mask", 9), field("Original Mask", 10)]},
        "104": {"id": 104, "name": "Image Occlusion", "type": 1, "tmpls": [{}], "flds": [
            field("Occlusion", 0), field("Image", 1), field("Header", 2), field("Back Extra", 3), field("Comments", 4)]},
        "105": {"id": 105, "name": "Lonely", "type": 0, "flds": [field("Only", 0)], "tmpls": [{}]},
    });
    conn.execute(
        "insert into col (decks, models) values (?1, ?2)",
        [decks.to_string(), models.to_string()],
    )
    .unwrap();
    write_cards(&conn, notes);
}

fn zip_of(path: &std::path::Path, entries: &[(&str, Vec<u8>)]) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

fn notes() -> Vec<Note> {
    vec![
        (1, 100, vec!["What is 1+1?", "2"], vec![(0, 11)]),
        (2, 101, vec!["a", "b"], vec![(0, 11), (1, 11)]),
        (3, 102, vec!["The {{c1::answer}}", "more"], vec![(0, 10)]),
        (4, 103, vec!["set1-ao-1", "Heading", r#"<img src="pic one.png">"#, "", "", "Note", "", "", "", "", r#"<img src="set1-ao-O.svg">"#], vec![(0, 11)]),
        (5, 103, vec!["set1-ao-2", "", r#"<img src="pic one.png" />"#, "", "", "", "", "", "", "", r#"<img src="set1-ao-O.svg">"#], vec![(0, 11)]),
        (6, 103, vec!["set1-ao-3", "", r#"<img src="pic one.png">"#, "", "", "", "", "", "", "", r#"<img src="set1-ao-O.svg">"#], vec![(0, 11)]),
        (7, 104, vec![
            "{{c1::image-occlusion:rect:left=0.1:top=0.2:width=0.3:height=0.1}}{{c1::image-occlusion:ellipse:left=0.5:top=0.5:rx=0.1:ry=0.2}}{{c2::image-occlusion:polygon:points=0.1,0.1 0.5,0.1 0.5,0.5}}",
            r#"<img src="pic%20one.png">"#, "Header", "Extra", ""], vec![(0, 11), (1, 11)]),
        (8, 105, vec!["only"], vec![(0, 11)]),
    ]
}

fn assert_package(package: &AnkiPackage) {
    let deck = |id| package.decks.iter().find(|d| d.id == id).unwrap();
    assert_eq!(package.decks.len(), 3, "the filtered deck is not listed");
    assert_eq!(deck(11).name, "Course::Maths");
    assert_eq!(deck(11).card_count, 9);
    assert_eq!(deck(10).card_count, 1);

    let kinds: Vec<_> = package.items.iter().map(|i| i.note_id).collect();
    assert_eq!(
        kinds,
        vec![1, 2, 3, 4, 7, 8],
        "enhanced notes of one set merge into the first"
    );
    assert_eq!(
        package.items[0].content,
        AnkiContent::Basic {
            front: "What is 1+1?".into(),
            back: "2".into(),
            extra: String::new(),
            reversed: false
        }
    );
    assert!(matches!(
        &package.items[1].content,
        AnkiContent::Basic { reversed: true, .. }
    ));
    assert_eq!(
        package.items[2].content,
        AnkiContent::Cloze {
            text: "The {{c1::answer}}".into(),
            extra: "more".into()
        }
    );
    assert_eq!(package.items[2].deck_id, 10);

    let AnkiContent::Occlusion {
        image,
        masks,
        header,
        extra,
        ..
    } = &package.items[3].content
    else {
        panic!("enhanced")
    };
    assert_eq!(
        (image.as_str(), header.as_str(), extra.as_str()),
        ("pic one.png", "Heading", "Note")
    );
    assert_eq!(masks.len(), 3, "the mask without a note is dropped");
    assert_eq!(
        masks[0].shape,
        MaskShape::Rectangle {
            x: 0.1,
            y: 0.1,
            width: 0.25,
            height: 0.25
        }
    );
    assert_eq!(
        masks[1].shape,
        MaskShape::Ellipse {
            cx: 0.5,
            cy: 0.5,
            rx: 0.05,
            ry: 0.05
        }
    );
    assert_eq!(
        masks[2].shape,
        MaskShape::Freehand {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 0.5, y: 0.0 },
                Point { x: 0.5, y: 0.5 }
            ]
        }
    );
    assert_eq!(masks[0].id, "set1-ao-1");

    let AnkiContent::Occlusion {
        image,
        masks,
        header,
        extra,
        ..
    } = &package.items[4].content
    else {
        panic!("builtin")
    };
    assert_eq!(
        (image.as_str(), header.as_str(), extra.as_str()),
        ("pic one.png", "Header", "Extra")
    );
    assert_eq!(masks.len(), 3);
    assert_eq!(masks[0].group, None);
    assert_eq!(
        masks[1].group.as_deref(),
        Some(masks[0].id.as_str()),
        "shapes of one cloze number are asked together"
    );
    assert_eq!(masks[2].group, None);
    assert_eq!(
        masks[1].shape,
        MaskShape::Ellipse {
            cx: 0.6,
            cy: 0.7,
            rx: 0.1,
            ry: 0.2
        }
    );

    assert!(
        matches!(&package.items[5].content, AnkiContent::Unsupported { notetype } if notetype == "Lonely")
    );
    assert_eq!(
        package.warnings,
        vec!["1 note of type Lonely can't be imported."]
    );
}

#[test]
fn reads_a_legacy_package() {
    let dir = temp();
    let db = dir.0.join("collection.anki21");
    legacy_db(&db, &notes());
    let path = dir.0.join("legacy.apkg");
    zip_of(
        &path,
        &[
            ("meta", vec![0x08, 0x02]),
            ("collection.anki2", b"not a database".to_vec()),
            ("collection.anki21", std::fs::read(&db).unwrap()),
            (
                "media",
                br#"{"0":"pic one.png","1":"set1-ao-O.svg"}"#.to_vec(),
            ),
            ("0", b"PNG".to_vec()),
            ("1", ENHANCED_SVG.as_bytes().to_vec()),
        ],
    );
    let archive = AnkiArchive::open(&path).unwrap();
    assert_package(&read_package(&archive).unwrap());
    assert_eq!(archive.read_media("pic one.png").unwrap(), b"PNG");
    assert!(archive.read_media("missing.png").is_err());
}

fn zstd(bytes: &[u8]) -> Vec<u8> {
    ruzstd::encoding::compress_to_vec(bytes, ruzstd::encoding::CompressionLevel::Fastest)
}

#[test]
fn reads_a_latest_package() {
    let dir = temp();
    let db = dir.0.join("latest.db");
    let conn = Connection::open(&db).unwrap();
    // Only the writer here knows the collation; the reader has to bring its own.
    conn.create_collation("unicase", |a, b| a.to_lowercase().cmp(&b.to_lowercase())).unwrap();
    conn.execute_batch(
        "create table col (decks text, models text, crt integer default 1000);
         insert into col (decks, models) values ('', '');
         -- Anki indexes names with its own collation, which the reader must supply.
         create table decks (id integer, name text collate unicase);
         create unique index idx_decks_name on decks (name);
         create table notetypes (id integer, name text collate unicase, config blob);
         create unique index idx_notetypes_name on notetypes (name);
         create table fields (ntid integer not null, ord integer not null, name text not null collate unicase, config blob,
                              primary key (ntid, ord)) without rowid;
         create unique index idx_fields_name_ntid on fields (name, ntid);
         create table templates (ntid integer, ord integer);",
    )
    .unwrap();
    conn.execute_batch(
        "insert into decks values (1, 'Default'), (10, 'Course'), (11, 'Course\x1fMaths');",
    )
    .unwrap();
    // Standard notetypes have no kind field; a cloze one has `kind = 1`.
    let types: [(i64, &str, i64, &[&str], i64); 6] = [
        (100, "Basic", 0, &["Front", "Back"], 1),
        (101, "Basic (and reversed card)", 0, &["Front", "Back"], 2),
        (102, "Cloze", 1, &["Text", "Back Extra"], 1),
        (
            103,
            "Image Occlusion Enhanced",
            0,
            &[
                "ID (hidden)",
                "Header",
                "Image",
                "Question Mask",
                "Footer",
                "Remarks",
                "Sources",
                "Extra 1",
                "Extra 2",
                "Answer Mask",
                "Original Mask",
            ],
            1,
        ),
        (
            104,
            "Image Occlusion",
            1,
            &["Occlusion", "Image", "Header", "Back Extra", "Comments"],
            1,
        ),
        (105, "Lonely", 0, &["Only"], 1),
    ];
    for (id, name, kind, fields, templates) in types {
        let config: Vec<u8> = if kind == 1 {
            vec![0x08, 0x01]
        } else {
            Vec::new()
        };
        conn.execute(
            "insert into notetypes values (?1, ?2, ?3)",
            rusqlite::params![id, name, config],
        )
        .unwrap();
        for (ord, field) in fields.iter().enumerate() {
            conn.execute(
                "insert into fields (ntid, ord, name) values (?1, ?2, ?3)",
                rusqlite::params![id, ord as i64, field],
            )
            .unwrap();
        }
        for ord in 0..templates {
            conn.execute(
                "insert into templates values (?1, ?2)",
                rusqlite::params![id, ord],
            )
            .unwrap();
        }
    }
    write_cards(&conn, &notes());
    drop(conn);

    // MediaEntries: entry 1 is "pic one.png" (zip entry "0"), entry 2 the SVG.
    let entry = |name: &str| {
        let mut message = vec![0x0a, name.len() as u8];
        message.extend(name.as_bytes());
        let mut wrapped = vec![0x0a, message.len() as u8];
        wrapped.extend(message);
        wrapped
    };
    let listing = [entry("pic one.png"), entry("set1-ao-O.svg")].concat();
    let path = dir.0.join("latest.apkg");
    zip_of(
        &path,
        &[
            ("meta", vec![0x08, 0x03]),
            ("collection.anki2", b"dummy".to_vec()),
            ("collection.anki21b", zstd(&std::fs::read(&db).unwrap())),
            ("media", zstd(&listing)),
            ("0", zstd(b"PNG")),
            ("1", zstd(ENHANCED_SVG.as_bytes())),
        ],
    );
    let archive = AnkiArchive::open(&path).unwrap();
    assert_package(&read_package(&archive).unwrap());
    assert_eq!(archive.read_media("pic one.png").unwrap(), b"PNG");
}

#[test]
fn rejects_things_that_are_not_packages() {
    let dir = temp();
    let path = dir.0.join("x.apkg");
    std::fs::write(&path, b"hello").unwrap();
    assert!(AnkiArchive::open(&path)
        .unwrap_err()
        .starts_with("This is not a valid Anki package"));
    zip_of(
        &path,
        &[("meta", vec![0x08, 0x09]), ("media", b"{}".to_vec())],
    );
    assert!(AnkiArchive::open(&path)
        .unwrap_err()
        .contains("not supported"));
    zip_of(&path, &[("media", b"{}".to_vec())]);
    let archive = AnkiArchive::open(&path).unwrap();
    assert_eq!(
        read_package(&archive).unwrap_err(),
        "This Anki package has no collection"
    );
}

#[test]
fn schedules_and_mask_owners_survive_package_reading() {
    let dir = temp();
    let db = dir.0.join("collection.anki2");
    legacy_db(&db, &notes());
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("update cards set type=2, queue=2, due=5, ivl=100, factor=1300, reps=12, lapses=2 where id=1001;
      update cards set type=1, queue=1, due=1700000000, ivl=-60 where id=1002;
      update cards set type=2, queue=-1, due=6 where id=1003;
      update cards set type=2, queue=2, due=999, odid=11, odue=7 where id=1004;
      insert into revlog values (100,1001,0,3,1,1,2500,1000,1), (200,1001,0,1,1,1,2500,1000,2),
      (300,1001,0,3,1,1,2500,1000,3), (400,1001,0,4,1,1,2500,1000,4), (500,1001,0,0,1,1,2500,1000,1),
      (600,1001,0,4,1,1,2500,1000,5);").unwrap();
    drop(conn);
    let path = dir.0.join("schedule.apkg");
    zip_of(
        &path,
        &[
            ("collection.anki2", std::fs::read(db).unwrap()),
            (
                "media",
                br#"{"0":"pic one.png","1":"set1-ao-O.svg"}"#.to_vec(),
            ),
            ("0", b"PNG".to_vec()),
            ("1", ENHANCED_SVG.as_bytes().to_vec()),
        ],
    );
    let package = read_package(&AnkiArchive::open(&path).unwrap()).unwrap();
    let card = &package.items[0].cards[0];
    assert_eq!(card.due, Some((1000 + 5 * 86400) * 1000));
    assert_eq!(
        (card.interval_days, card.ease, card.reps, card.lapses),
        (100.0, 1.3, 12, 2)
    );
    assert_eq!(
        card.reviews
            .iter()
            .map(|r| (r.time, r.rating))
            .collect::<Vec<_>>(),
        [(100, 3), (200, 1)]
    );
    assert_eq!(package.items[1].cards[0].due, Some(1700000000000));
    assert_eq!(package.items[1].cards[0].interval_days, 60.0 / 86400.0);
    assert!(package.items[1].cards[1].suspended);
    assert_eq!(
        package.items[2].cards[0].due,
        Some((1000 + 7 * 86400) * 1000)
    );
    assert_eq!(
        package.items[3]
            .cards
            .iter()
            .map(|c| c.mask.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["set1-ao-1", "set1-ao-2", "set1-ao-3"]
    );
    assert_eq!(
        package.items[4]
            .cards
            .iter()
            .map(|c| c.mask.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["c1-0", "c2-2"]
    );
    let mut sessions = Sessions::default();
    let opened = sessions.open(&path).unwrap();
    std::fs::remove_file(&path).unwrap(); // The dialog owns a snapshot, not a path lease.
    assert_eq!(
        sessions
            .read_media(&opened.source_id, &["pic one.png".into()])
            .unwrap(),
        [b"PNG".to_vec()]
    );
    assert!(sessions
        .read_media(&opened.source_id, &vec!["pic one.png".into(); 257])
        .is_err());
    sessions.close(&opened.source_id);
    assert!(sessions
        .read_media(&opened.source_id, &["pic one.png".into()])
        .is_err());
}

#[test]
fn literal_anki_shape_values_and_svg_labels() {
    let field = r"{{c1::image-occlusion:ellipse:left=0.25:top=0.25:rx=0.1:ry=0.2:oi=1}}<br>{{c2::image-occlusion:polygon:left=0:top=0:points=0,0 1.,0 0.5,0.5}}<br>{{c0::image-occlusion:text:left=0.1:top=0.2:text=a\:b\\c:fs=0.04:scale=2:fill=#123456}}";
    let masks = occlusion::builtin_masks(field);
    assert_eq!(
        masks[0].shape,
        MaskShape::Ellipse {
            cx: 0.35,
            cy: 0.45,
            rx: 0.1,
            ry: 0.2
        }
    );
    assert!(matches!(&masks[1].shape, MaskShape::Freehand { points } if points[1].x == 1.0));
    let labels = occlusion::builtin_labels(field);
    assert_eq!(labels[0].text, r"a:b\c");
    assert_eq!(labels[0].size, 0.08);
    let labels = occlusion::enhanced_labels(
        r##"<svg width="800" height="400"><g><title>Labels</title><text x="80" y="40" font-size="20" fill="#ff0000">A &amp; B</text></g></svg>"##,
    );
    assert_eq!(
        labels[0],
        AnkiLabel {
            text: "A & B".into(),
            x: 0.1,
            y: 0.1,
            size: 0.05,
            color: "#ff0000".into(),
            baseline: "alphabetic".into()
        }
    );
}
