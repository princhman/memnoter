use super::*;
use crate::{content, files, sync, Core};
use serde_json::{json, Value};
use yrs::{Any, ArrayPrelim, In, MapPrelim, StateVector, XmlFragmentPrelim};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/worksheets.json")).unwrap()
}
fn input(key: &str, value: &Value) -> In {
    if key == "text" {
        return In::XmlFragment(XmlFragmentPrelim::default());
    }
    if key == "revision" || key == "copy" {
        return In::Any(Any::from_json(&value.to_string()).unwrap());
    }
    match value {
        Value::Object(map) => In::Map(
            map.iter()
                .map(|(k, v)| (k.clone(), input(k, v)))
                .collect::<MapPrelim>(),
        ),
        Value::Array(array) => In::Array(
            array
                .iter()
                .map(|v| input(if key == "copies" { "copy" } else { "" }, v))
                .collect::<ArrayPrelim>(),
        ),
        _ => In::Any(Any::from_json(&value.to_string()).unwrap()),
    }
}
fn document(value: &Value) -> Doc {
    let doc = Doc::new();
    let map = doc.get_or_insert_map(ROOT);
    let mut txn = doc.transact_mut();
    for (k, v) in value.as_object().unwrap() {
        map.insert(&mut txn, k.as_str(), input(k, v));
    }
    let Out::YMap(answers) = map.get(&txn, "answers").unwrap() else {
        panic!()
    };
    for (key, answer) in answers
        .iter(&txn)
        .map(|(k, v)| (k.to_owned(), v))
        .collect::<Vec<_>>()
    {
        let Out::YMap(answer) = answer else { panic!() };
        let Out::YXmlFragment(text) = answer.get(&txn, "text").unwrap() else {
            panic!()
        };
        use yrs::XmlFragment;
        text.push_back(
            &mut txn,
            yrs::XmlTextPrelim::new(value["answers"][&key]["text"].as_str().unwrap()),
        );
    }
    drop(txn);
    doc
}
fn bytes(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
struct Temp(std::path::PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn core() -> (Temp, Core, String) {
    let dir = Temp(std::env::temp_dir().join(format!("worksheets-{}", uuid::Uuid::new_v4())));
    let core = Core::open(&dir.0).unwrap();
    let module = content::create_module(&core.db, "Worksheet".into()).unwrap();
    (dir, core, module)
}
fn assets(core: &Core, module: &str, bank: &Bank) {
    let conn = core.db.lock().unwrap();
    for id in bank.assets() {
        let exists: bool = conn
            .query_row(
                "select exists(select 1 from files where id=?1)",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        if exists {
            continue;
        }
        files::assets::write(core.data_dir(), &id, b"immutable-asset").unwrap();
        let mime = if bank.answers.values().any(|a| {
            a.canvases.values().any(|c| {
                c.revision
                    .iter()
                    .chain(&c.copies)
                    .any(|ink| ink.source_id == id)
            })
        }) {
            "application/vnd.memnoter.drawing+json"
        } else if bank
            .revisions
            .values()
            .any(|r| r.crops.values().any(|c| c.source_pdf_file_id == id))
        {
            "application/pdf"
        } else {
            "image/png"
        };
        conn.execute(
            "insert into files(id,module_id,path,file_type) values (?1,?2,?3,?4)",
            rusqlite::params![
                id,
                module,
                files::assets::path(core.data_dir(), &id)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                mime
            ],
        )
        .unwrap();
        sync::record_file(&conn, &id, module, mime).unwrap();
    }
}

#[test]
fn stale_note_compaction_preserves_unseen_answers_and_bank_edits() {
    let (_dir, core, module) = core();
    let value = fixture();
    let bank: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &bank);
    let doc = document(&value);
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    let stale = bytes(&doc);
    // Core-side writes happen while a note editor still holds the old snapshot.
    let root = doc.get_or_insert_map(ROOT);
    let mut txn = doc.transact_mut();
    let Out::YMap(questions) = root.get(&txn, "questions").unwrap() else { panic!() };
    let question_id = bank.questions.keys().next().unwrap();
    let Out::YMap(question) = questions.get(&txn, question_id).unwrap() else { panic!() };
    question.insert(&mut txn, "title", "Renamed while answering");
    question.insert(&mut txn, "order", 42);
    let Out::YMap(answers) = root.get(&txn, "answers").unwrap() else { panic!() };
    let answer_id = bank.answers.keys().next().unwrap();
    let Out::YMap(answer) = answers.get(&txn, answer_id).unwrap() else { panic!() };
    let text = answer.insert(&mut txn, "text", XmlFragmentPrelim::default());
    use yrs::XmlFragment;
    text.push_back(&mut txn, yrs::XmlTextPrelim::new("Saved while the note was open"));
    drop(txn);
    let watermark = content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap().id;
    let expected = read(&doc).unwrap();
    // A further write must remain above the watermark and survive validation.
    question.insert(&mut doc.transact_mut(), "title", "Later rename");
    let later = content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    content::save_compaction(&core.db, module.clone(), stale.clone(), watermark).unwrap();
    let saved = content::get_content(&core.db, module.clone()).unwrap();
    let snapshot = Doc::new();
    snapshot.transact_mut().apply_update(Update::decode_v1(&saved.state).unwrap()).unwrap();
    assert_eq!(read(&snapshot).unwrap(), expected);
    assert_eq!(saved.updates.len(), 1);
    assert_eq!(saved.updates[0].id, later.id);
    assert_eq!(read(&load(&core.db.lock().unwrap(), &module).unwrap()).unwrap(), read(&doc).unwrap());
    // A second stale compaction must succeed too, rather than poison all retries.
    content::save_compaction(&core.db, module.clone(), stale, later.id).unwrap();
    assert_eq!(read(&load(&core.db.lock().unwrap(), &module).unwrap()).unwrap(), read(&doc).unwrap());
}

#[test]
fn roundtrip_pinned_tree_multicrop_answers_and_conflict_copies() {
    let bank: Bank = serde_json::from_value(fixture()).unwrap();
    let doc = document(&fixture());
    let copy = Doc::new();
    copy.transact_mut()
        .apply_update(Update::decode_v1(&bytes(&doc)).unwrap())
        .unwrap();
    assert_eq!(read(&copy).unwrap(), Some(bank.clone()));
    assert_eq!(bank.assets().len(), 7); // two crops, PDF, source/preview, conflict source/preview
    let (_dir, core, module) = core();
    assets(&core, &module, &bank);
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    let state = load(&core.db.lock().unwrap(), &module).unwrap();
    content::save_compaction(&core.db, module.clone(), bytes(&state), i64::MAX).unwrap();
    let bank_after = read(&load(&core.db.lock().unwrap(), &module).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(bank_after, bank);
    sync::sync_enable(&core.db, "account".into()).unwrap();
    let generation = serde_json::to_value(sync::sync_status(&core.db).unwrap()).unwrap()
        ["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let vault = sync::sync_snapshot(&core.db, "vault".into(), generation.clone())
        .unwrap()
        .unwrap();
    let snapshot = sync::sync_snapshot(&core.db, module.clone(), generation)
        .unwrap()
        .unwrap();
    let peer_dir =
        Temp(std::env::temp_dir().join(format!("worksheet-peer-{}", uuid::Uuid::new_v4())));
    let peer = Core::open(&peer_dir.0).unwrap();
    sync::sync_enable(&peer.db, "account".into()).unwrap();
    let generation = serde_json::to_value(sync::sync_status(&peer.db).unwrap()).unwrap()
        ["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    sync::sync_apply(
        peer.data_dir(),
        &peer.db,
        serde_json::from_value(json!([
            {"seq":1,"doc":"vault","bytes":vault},{"seq":2,"doc":module,"bytes":snapshot}
        ]))
        .unwrap(),
        2,
        generation.clone(),
    )
    .unwrap();
    assert_eq!(
        read(&load(&peer.db.lock().unwrap(), &module).unwrap()).unwrap(),
        Some(bank.clone())
    );
    let missing =
        serde_json::to_value(sync::sync_missing_files(&peer.db, generation).unwrap()).unwrap();
    assert_eq!(
        missing
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["fileId"].as_str().unwrap().to_owned())
            .collect::<HashSet<_>>(),
        bank.assets()
    );
    // Sync cannot rewrite a revision already pinned on the receiving device.
    let tampered = load(&core.db.lock().unwrap(), &module).unwrap();
    let root = tampered.get_or_insert_map(ROOT);
    let mut txn = tampered.transact_mut();
    let Out::YMap(revisions) = root.get(&txn, "revisions").unwrap() else {
        panic!()
    };
    let (rid, revision) = bank.revisions.iter().next().unwrap();
    let Out::YMap(record) = revisions.get(&txn, rid).unwrap() else {
        panic!()
    };
    let Out::YMap(parts) = record.get(&txn, "parts").unwrap() else {
        panic!()
    };
    let Out::YMap(part) = parts.get(&txn, &revision.root_part_id).unwrap() else {
        panic!()
    };
    part.insert(&mut txn, "label", "unexpected remote rewrite");
    drop(txn);
    let generation = serde_json::to_value(sync::sync_status(&peer.db).unwrap()).unwrap()
        ["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(sync::sync_apply(
        peer.data_dir(),
        &peer.db,
        serde_json::from_value(json!([
            {"seq":3,"doc":module,"bytes":bytes(&tampered)}
        ]))
        .unwrap(),
        3,
        generation
    )
    .unwrap_err()
    .contains("immutable"));
    assert_eq!(
        read(&load(&peer.db.lock().unwrap(), &module).unwrap()).unwrap(),
        Some(bank.clone())
    );
    // A v0.1.5 collector sees no image references in default and proposes all
    // seven files. The new core must independently retain every one of them.
    let root = state.get_or_insert_xml_fragment("default");
    assert!(files::assets::note_images(&root, &state.transact()).is_empty());
    let content = content::get_content(&core.db, module.clone()).unwrap();
    assert!(files::cleanup_files(
        core.data_dir(),
        &core.db,
        module.clone(),
        bank.assets().into_iter().collect(),
        content.state,
        0
    )
    .unwrap()
    .is_empty());
    let backup = crate::backups::create(
        &core.db.lock().unwrap(),
        core.data_dir(),
        chrono::Utc::now(),
    )
    .unwrap();
    // Backup exports the whole CRDT and every managed file.
    let id = serde_json::to_value(backup).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    crate::backups::restore_backup(core.data_dir(), &core.db, id).unwrap();
    assert_eq!(
        read(&load(&core.db.lock().unwrap(), &module).unwrap()).unwrap(),
        Some(bank.clone())
    );
    for id in bank.assets() {
        assert_eq!(
            std::fs::read(files::assets::path(core.data_dir(), &id).unwrap()).unwrap(),
            b"immutable-asset"
        );
    }
    content::delete_module(core.data_dir(), &core.db, module).unwrap();
    for id in bank.assets() {
        assert!(!files::assets::path(core.data_dir(), &id).unwrap().exists());
    }
}

#[test]
fn rejects_invalid_graph_crop_keys_and_assets_without_publishing() {
    let value = fixture();
    let rid = value["revisions"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let revision = &value["revisions"][&rid];
    let root = revision["rootPartId"].as_str().unwrap().to_owned();
    let leaf = revision["parts"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| **k != root)
        .unwrap()
        .clone();
    let crop = revision["crops"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let key = value["answers"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let mut cases = Vec::new();
    let mut v = value.clone();
    v["revisions"][&rid]["parts"][&root]["parentId"] = json!(leaf);
    cases.push(v);
    let mut v = value.clone();
    v["revisions"][&rid]["parts"][&leaf]["parentId"] = json!(uuid::Uuid::new_v4().to_string());
    cases.push(v);
    let mut v = value.clone();
    v["revisions"][&rid]["crops"][&crop]["rect"] = json!([0.9, 0, 0.2, 1]);
    cases.push(v);
    let mut v = value.clone();
    v["revisions"][&rid]["crops"][&crop]["rotation"] = json!(45);
    cases.push(v);
    let mut v = value.clone();
    v["revisions"][&rid]["crops"][&crop]["pixelSize"] = json!([0, 100]);
    cases.push(v);
    let mut v = value.clone();
    v["revisions"][&rid]["crops"][&crop]["partId"] = json!(leaf);
    cases.push(v);
    let mut v = value.clone();
    v["answers"][&key]["leafPartId"] = json!(root);
    cases.push(v);
    let mut v = value.clone();
    v["attempts"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["questions"][0]["revisionId"] = json!(uuid::Uuid::new_v4().to_string());
    cases.push(v);
    let new_rid = uuid::Uuid::new_v4().to_string();
    let mut v = value.clone();
    let mut changed = v["revisions"][&rid].clone();
    let other_crop = changed["crops"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| **k != crop)
        .unwrap()
        .clone();
    changed["crops"][&crop]["assetId"] = changed["crops"][&other_crop]["assetId"].clone();
    v["revisions"][&new_rid] = changed;
    cases.push(v);
    let mut v = value.clone();
    let qid = uuid::Uuid::new_v4().to_string();
    let mut foreign = v["revisions"][&rid].clone();
    foreign["questionId"] = json!(qid);
    v["revisions"][&new_rid] = foreign;
    v["questions"][qid] =
        json!({"title":"Other question","order":1,"revisionId":new_rid,"deleted":false});
    cases.push(v);
    let (_dir, core, module) = core();
    let valid: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &valid);
    for value in cases {
        assert!(
            content::add_update(&core.db, module.clone(), bytes(&document(&value)))
                .unwrap_err()
                .contains("Invalid worksheet")
        );
    }
    let mut missing = value.clone();
    missing["revisions"][&rid]["crops"][&crop]["assetId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(
        content::add_update(&core.db, module.clone(), bytes(&document(&missing)))
            .unwrap_err()
            .contains("asset")
    );
    assert!(content::get_content(&core.db, module)
        .unwrap()
        .updates
        .is_empty());
}

#[test]
fn local_updates_cannot_rewrite_pinned_revisions_or_drop_unknown_roots() {
    let (_dir, core, module) = core();
    let value = fixture();
    let bank: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &bank);
    let doc = document(&value);
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    let rid = value["revisions"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap();
    let root = doc.get_or_insert_map(ROOT);
    let mut txn = doc.transact_mut();
    let Out::YMap(revisions) = root.get(&txn, "revisions").unwrap() else {
        panic!()
    };
    let new_id = uuid::Uuid::new_v4().to_string();
    let leaf = bank.answers.values().next().unwrap().leaf_part_id.clone();
    let mut next = value["revisions"][rid].clone();
    next["parts"][uuid::Uuid::new_v4().to_string()] =
        json!({"parentId":leaf,"order":0,"label":"(i)","cropIds":[]});
    revisions.insert(&mut txn, new_id.as_str(), input("", &next));
    let Out::YMap(questions) = root.get(&txn, "questions").unwrap() else {
        panic!()
    };
    let Out::YMap(question) = questions
        .get(&txn, &bank.revisions[rid].question_id)
        .unwrap()
    else {
        panic!()
    };
    question.insert(&mut txn, "revisionId", new_id.as_str());
    drop(txn);
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    let pinned = read(&load(&core.db.lock().unwrap(), &module).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        pinned.answers, bank.answers,
        "Adding children in a new revision must not reassign the old leaf answer"
    );
    let separate = load(&core.db.lock().unwrap(), &module).unwrap();
    let separate_root = separate.get_or_insert_map(ROOT);
    let mut txn = separate.transact_mut();
    let Out::YMap(attempts) = separate_root.get(&txn, "attempts").unwrap() else {
        panic!()
    };
    let Out::YMap(attempt) = attempts
        .get(&txn, bank.attempts.keys().next().unwrap())
        .unwrap()
    else {
        panic!()
    };
    let Out::YArray(pins) = attempt.get(&txn, "questions").unwrap() else {
        panic!()
    };
    use yrs::Array;
    let Out::YMap(pin) = pins.get(&txn, 0).unwrap() else {
        panic!()
    };
    pin.insert(&mut txn, "revisionId", new_id.as_str());
    let Out::YMap(answers) = separate_root.get(&txn, "answers").unwrap() else {
        panic!()
    };
    answers.clear(&mut txn);
    drop(txn);
    assert!(
        content::add_update(&core.db, module.clone(), bytes(&separate))
            .unwrap_err()
            .contains("pinned")
    );
    let mut txn = doc.transact_mut();
    let Out::YMap(revision) = revisions.get(&txn, rid).unwrap() else {
        panic!()
    };
    let Out::YMap(parts) = revision.get(&txn, "parts").unwrap() else {
        panic!()
    };
    let root_id = value["revisions"][rid]["rootPartId"].as_str().unwrap();
    let Out::YMap(part) = parts.get(&txn, root_id).unwrap() else {
        panic!()
    };
    part.insert(&mut txn, "label", "silently rewritten prompt");
    drop(txn);
    assert!(content::add_update(&core.db, module.clone(), bytes(&doc))
        .unwrap_err()
        .contains("immutable"));
    // Empty stale clients cannot erase saved history during compaction.
    content::save_compaction(&core.db, module, Vec::new(), i64::MAX).unwrap();
}

#[test]
fn future_roots_survive_sync_backup_and_refuse_cleanup_even_from_old_ui() {
    let (_dir, core, module) = core();
    let bank: Bank = serde_json::from_value(fixture()).unwrap();
    assets(&core, &module, &bank);
    let doc = document(&fixture());
    doc.get_or_insert_map("futureWorksheetRoot")
        .insert(&mut doc.transact_mut(), "version", 2);
    let encoded = bytes(&doc);
    // Remote sync stores opaque updates. It must not normalize future data.
    sync::sync_enable(&core.db, "account".into()).unwrap();
    let generation = serde_json::to_value(sync::sync_status(&core.db).unwrap()).unwrap()
        ["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    sync::sync_apply(
        core.data_dir(),
        &core.db,
        vec![serde_json::from_value(json!({"seq":1,"doc":module,"bytes":encoded})).unwrap()],
        1,
        generation.clone(),
    )
    .unwrap();
    let snapshot = sync::sync_snapshot(&core.db, module.clone(), generation)
        .unwrap()
        .unwrap();
    let restored = Doc::new();
    restored
        .transact_mut()
        .apply_update(Update::decode_v1(&snapshot).unwrap())
        .unwrap();
    assert_eq!(
        restored.transact().state_vector(),
        doc.transact().state_vector()
    );
    for name in [ROOT, "futureWorksheetRoot"] {
        assert_eq!(
            restored
                .get_or_insert_map(name)
                .to_json(&restored.transact()),
            doc.get_or_insert_map(name).to_json(&doc.transact())
        );
    }
    assert!(read(&restored).is_err());
    let content = content::get_content(&core.db, module.clone()).unwrap();
    assert!(files::cleanup_files(
        core.data_dir(),
        &core.db,
        module.clone(),
        bank.assets().into_iter().collect(),
        content.state,
        content.updates.last().unwrap().id
    )
    .unwrap()
    .is_empty());
    assert!(content::add_update(&core.db, module.clone(), vec![0, 0]).is_err());
    assert!(content::delete_module(core.data_dir(), &core.db, module).is_err());
    let orphan = uuid::Uuid::new_v4().to_string();
    let path = files::assets::write(core.data_dir(), &orphan, b"future asset metadata").unwrap();
    files::assets::cleanup_orphans(&core.db.lock().unwrap(), &core.data_dir().join("files"))
        .unwrap();
    assert!(
        path.exists(),
        "Unknown roots must also quarantine startup orphan collection"
    );

    for id in bank.assets() {
        assert!(files::assets::path(core.data_dir(), &id).unwrap().exists());
    }
}

#[test]
fn future_survivor_retains_assets_when_the_uploader_module_is_deleted() {
    let (_dir, core, module) = core();
    let pdf = crate::add_document_bytes(
        core.data_dir(),
        &core.db,
        module.clone(),
        "Source.pdf".into(),
        b"%PDF-1.7".to_vec(),
    )
    .unwrap();
    let mut value = fixture();
    for revision in value["revisions"].as_object_mut().unwrap().values_mut() {
        for crop in revision["crops"].as_object_mut().unwrap().values_mut() {
            crop["sourcePdfFileId"] = json!(pdf.id);
        }
    }
    let bank: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &bank);
    content::add_update(&core.db, module.clone(), bytes(&document(&value))).unwrap();
    let survivor = content::create_module(&core.db, "Future worksheet".into()).unwrap();
    let doc = Doc::new();
    doc.get_or_insert_map("futureRoot")
        .insert(&mut doc.transact_mut(), "version", 2);
    sync::sync_enable(&core.db, "account".into()).unwrap();
    let generation = serde_json::to_value(sync::sync_status(&core.db).unwrap()).unwrap()
        ["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    sync::sync_apply(
        core.data_dir(),
        &core.db,
        serde_json::from_value(json!([
            {"seq":1,"doc":survivor,"bytes":bytes(&doc)}
        ]))
        .unwrap(),
        1,
        generation,
    )
    .unwrap();
    assert!(crate::delete_document(core.data_dir(), &core.db, pdf.id.clone()).is_err());
    content::delete_module(core.data_dir(), &core.db, module).unwrap();
    let documents =
        serde_json::to_value(crate::list_documents(core.data_dir(), &core.db, None).unwrap())
            .unwrap();
    assert_eq!(documents[0]["moduleId"], survivor);
    for id in bank.assets() {
        assert!(files::assets::path(core.data_dir(), &id).unwrap().exists());
        let owner: String = core
            .db
            .lock()
            .unwrap()
            .query_row("select module_id from files where id=?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(owner, survivor);
    }
}

#[test]
fn finish_retains_answers_and_pins_and_rejects_further_writes() {
    let _lock = super::DEV_TEST_LOCK.lock().unwrap();
    let (dir, core, module) = core();
    struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Environment {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value { Some(value) => std::env::set_var(key, value), None => std::env::remove_var(key) }
            }
        }
    }
    let _environment = Environment(["MEMNOTER_DATA_DIR", "MEMNOTER_QUESTION_BANK_DEV"].into_iter().map(|key| (key, std::env::var_os(key))).collect());
    std::env::set_var("MEMNOTER_DATA_DIR", &dir.0);
    std::env::set_var("MEMNOTER_QUESTION_BANK_DEV", "1");
    std::fs::write(dir.0.join(bank::DEV_MARKER), dir.0.canonicalize().unwrap().to_string_lossy().as_bytes()).unwrap();
    let value = fixture();
    let before: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &before);
    content::add_update(&core.db, module.clone(), bytes(&document(&value))).unwrap();
    let attempt = before.attempts.keys().next().unwrap().clone();
    let pin = &before.attempts[&attempt].questions[0];
    let leaf = before.revisions[&pin.revision_id].parts.iter().find(|(id, _)| !before.revisions[&pin.revision_id].parts.values().any(|p| p.parent_id.as_ref() == Some(id))).unwrap().0.clone();
    attempts::save_answer(&core, module.clone(), attempt.clone(), pin.revision_id.clone(), leaf.clone(), "Final answer".into()).unwrap();
    let saved = bank::get(&core, module.clone()).unwrap().unwrap();
    attempts::finish(&core, module.clone(), attempt.clone()).unwrap();
    let finished = bank::get(&core, module.clone()).unwrap().unwrap();
    assert!(finished.attempts[&attempt].finished);
    assert_eq!(finished.attempts[&attempt].questions, saved.attempts[&attempt].questions);
    assert_eq!(finished.answers, saved.answers);
    attempts::finish(&core, module.clone(), attempt.clone()).unwrap(); // retry is harmless
    let loaded = attempts::load_answer_document(&core, module.clone(), attempt.clone(), pin.revision_id.clone(), leaf.clone()).unwrap();
    assert!(attempts::save_answer(&core, module.clone(), attempt.clone(), pin.revision_id.clone(), leaf.clone(), "Changed".into()).err().unwrap().to_string().contains("read-only"));
    let doc = Doc::new();
    doc.get_or_insert_xml_fragment("default");
    let expected = serde_json::to_value(loaded).unwrap()["expected"].as_str().unwrap().to_owned();
    assert!(attempts::save_answer_document(&core, module.clone(), attempt.clone(), pin.revision_id.clone(), leaf.clone(), bytes(&doc), expected).is_err());
    assert!(attempts::save_canvas(&core, module.clone(), attempt, pin.revision_id.clone(), leaf, uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string(), None, 100.0, 100.0, false).is_err());
    assert_eq!(bank::get(&core, module).unwrap().unwrap(), finished);
}

fn generation(core: &Core) -> String {
    serde_json::to_value(sync::sync_status(&core.db).unwrap()).unwrap()["generation"].as_str().unwrap().to_owned()
}

// Exercise production vault + module transport and the file download boundary.
fn replicate(source: &Core, peer: &Core, module: &str, seq: i64) {
    let source_generation = generation(source);
    let entries = ["vault", module].into_iter().enumerate().map(|(index, doc)| {
        json!({"seq": seq + index as i64, "doc": doc,
            "bytes": sync::sync_snapshot(&source.db, doc.into(), source_generation.clone()).unwrap().unwrap()})
    }).collect::<Vec<_>>();
    let peer_generation = generation(peer);
    // Deliver file metadata and bytes before the note, as real independent
    // upload/download queues can. Cleanup must be harmless in this interval.
    sync::sync_apply(peer.data_dir(), &peer.db, serde_json::from_value(json!([entries[0]])).unwrap(), seq, peer_generation.clone()).unwrap();
    let missing = serde_json::to_value(sync::sync_missing_files(&peer.db, peer_generation.clone()).unwrap()).unwrap();
    for file in missing.as_array().unwrap() {
        let id = file["fileId"].as_str().unwrap();
        let data = std::fs::read(files::assets::path(source.data_dir(), id).unwrap()).unwrap();
        sync::sync_store_file(peer.data_dir(), &peer.db, id.into(), file["moduleId"].as_str().unwrap().into(), file["fileType"].as_str().unwrap().into(), data.clone(), peer_generation.clone()).unwrap();
        assert_eq!(std::fs::read(files::assets::path(peer.data_dir(), id).unwrap()).unwrap(), data);
        assert!(cleanup(peer, file["moduleId"].as_str().unwrap(), id).is_empty(), "downloads must survive cleanup before publication");
    }
    sync::sync_apply(peer.data_dir(), &peer.db, serde_json::from_value(json!([entries[1]])).unwrap(), seq + 1, peer_generation.clone()).unwrap();
    assert!(sync::sync_missing_files(&peer.db, peer_generation).unwrap().is_empty());
}

fn answer_doc(text: &str, image: Option<&str>, drawing_source: Option<&str>) -> Vec<u8> {
    use yrs::{Xml, XmlFragment};
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let p = fragment.push_back(&mut txn, yrs::XmlElementPrelim::empty("paragraph"));
    p.push_back(&mut txn, yrs::XmlTextPrelim::new(text));
    if let Some(id) = image {
        let node = fragment.push_back(&mut txn, yrs::XmlElementPrelim::empty("image"));
        node.insert_attribute(&mut txn, "fileId", id);
        if let Some(source) = drawing_source {
            node.insert_attribute(&mut txn, "drawing", Any::from_json(&json!({
                "version": 1, "sourceId": source, "previewId": id
            }).to_string()).unwrap());
        }
    }
    drop(txn);
    bytes(&doc)
}

fn cleanup(core: &Core, module: &str, id: &str) -> Vec<String> {
    let snapshot = content::get_content(&core.db, module.into()).unwrap();
    let watermark = snapshot.updates.iter().map(|u| u.id).max().unwrap_or(0);
    files::cleanup_files(core.data_dir(), &core.db, module.into(), vec![id.into()], snapshot.state, watermark).unwrap()
}

#[test]
fn answer_upload_survives_cleanup_before_publication_and_releases_after_undo_session() {
    let (dir, core, module) = core();
    let value = fixture();
    let bank: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &bank);
    content::add_update(&core.db, module.clone(), bytes(&document(&value))).unwrap();
    let owner = bank.answers.values().next().unwrap();
    let image = files::save_file(core.data_dir(), &core.db, module.clone(), b"pending answer image".to_vec(), "image/png".into()).unwrap().id;
    assert!(cleanup(&core, &module, &image).is_empty(), "a note load must not collect an uncommitted answer image");
    drop(core);
    let core = Core::open(&dir.0).unwrap();
    assert!(cleanup(&core, &module, &image).is_empty(), "pending draft assets survive restart");
    let save = |document| {
        let loaded = attempts::load_answer_document(&core, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone()).unwrap();
        let expected = serde_json::to_value(loaded).unwrap()["expected"].as_str().unwrap().into();
        attempts::save_answer_document(&core, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone(), document, expected).unwrap();
    };
    save(answer_doc("Published", Some(&image), None));
    assert!(cleanup(&core, &module, &image).is_empty());
    save(answer_doc("Image deliberately removed", None, None));
    let state = load(&core.db.lock().unwrap(), &module).unwrap();
    content::save_compaction(&core.db, module.clone(), bytes(&state), i64::MAX).unwrap();
    assert!(cleanup(&core, &module, &image).is_empty(), "live undo retains published assets through compaction");
    drop(core);
    let core = Core::open(&dir.0).unwrap();
    assert_eq!(cleanup(&core, &module, &image), vec![image.clone()], "published leases end after the undo session when no current reference remains");
    assert!(!files::assets::path(core.data_dir(), &image).unwrap().exists());
    for id in bank.assets() {
        assert!(files::assets::path(core.data_dir(), &id).unwrap().is_file(), "pinned crop and drawing history must stay available");
    }
}

#[test]
fn offline_answer_replacements_converge_without_losing_either_devices_text_or_images() {
    for first_answer in [true, false] {
        let (_dir, core, module) = core();
        let (_peer_dir, peer, _) = self::core();
        let mut value = fixture();
        let owner: Answer = serde_json::from_value(value["answers"].as_object().unwrap().values().next().unwrap().clone()).unwrap();
        if first_answer { value["answers"] = json!({}); }
        let bank: Bank = serde_json::from_value(value.clone()).unwrap();
        assets(&core, &module, &bank);
        content::add_update(&core.db, module.clone(), bytes(&document(&value))).unwrap();
        sync::sync_enable(&core.db, "account".into()).unwrap();
        sync::sync_enable(&peer.db, "account".into()).unwrap();
        replicate(&core, &peer, &module, 1);
        let mut image_ids = Vec::new();
        for (device, text) in [(&core, "Device A answer"), (&peer, "Device B answer")] {
            let loaded = attempts::load_answer_document(device, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone()).unwrap();
            let expected = serde_json::to_value(loaded).unwrap()["expected"].as_str().unwrap().into();
            let image = files::save_file(device.data_dir(), &device.db, module.clone(), text.as_bytes().to_vec(), "image/png".into()).unwrap().id;
            let source = files::save_file(device.data_dir(), &device.db, module.clone(), br#"{"strokes":[]}"#.to_vec(), "application/vnd.memnoter.drawing+json".into()).unwrap().id;
            attempts::save_answer_document(device, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone(), answer_doc(text, Some(&image), Some(&source)), expected).unwrap();
            assert!(sync::sync_pending_uploads(&device.db, generation(device)).unwrap().contains(&source));
            image_ids.push(source);
            assert!(sync::sync_pending_uploads(&device.db, generation(device)).unwrap().contains(&image));
            image_ids.push(image);
        }
        replicate(&core, &peer, &module, 3);
        replicate(&peer, &core, &module, 5);
        let merged = bank::get(&core, module.clone()).unwrap().unwrap();
        let without_display = |mut bank: Bank| {
            for answer in bank.answers.values_mut() { answer.text.clear(); }
            bank
        };
        // XML display strings do not canonicalize Any-map attribute ordering.
        // Compare the typed answer token and the remaining metadata separately.
        let answer_token = |device: &Core| {
            let loaded = attempts::load_answer_document(device, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone()).unwrap();
            serde_json::to_value(loaded).unwrap()["expected"].as_str().unwrap().to_owned()
        };
        let merged_token = answer_token(&core);
        assert_eq!(answer_token(&peer), merged_token);
        assert_eq!(without_display(merged.clone()), without_display(bank::get(&peer, module.clone()).unwrap().unwrap()));
        let answer = &merged.answers[&serde_json::to_string(&[&owner.attempt_id, &owner.revision_id, &owner.leaf_part_id]).unwrap()];
        assert!(answer.text.contains("Device A answer") && answer.text.contains("Device B answer"), "offline first={first_answer}: {}", answer.text);
        let current = document_assets(&load(&core.db.lock().unwrap(), &module).unwrap()).unwrap();
        for image in image_ids { assert!(current.contains(&image)); assert!(cleanup(&core, &module, &image).is_empty()); }
        // A stale same-device editor must still get a conflict, keeping its draft.
        assert!(attempts::save_answer_document(&core, module.clone(), owner.attempt_id.clone(), owner.revision_id.clone(), owner.leaf_part_id.clone(), answer_doc("stale", None, None), "[]".into()).err().unwrap().to_string().contains("changed elsewhere"));
        attempts::finish(&core, module.clone(), owner.attempt_id.clone()).unwrap();
        replicate(&core, &peer, &module, 7);
        let finished = bank::get(&peer, module.clone()).unwrap().unwrap();
        assert!(finished.attempts[&owner.attempt_id].finished);
        assert_eq!(answer_token(&peer), merged_token);
        assert_eq!(without_display(finished).answers, without_display(merged).answers);
    }
}

#[test]
fn first_bank_questions_created_offline_on_two_devices_both_survive_sync() {
    let (_dir, core, module) = core();
    let (_peer_dir, peer, _) = self::core();
    sync::sync_enable(&core.db, "account".into()).unwrap();
    sync::sync_enable(&peer.db, "account".into()).unwrap();
    replicate(&core, &peer, &module, 1);
    let mut question_ids = HashSet::new();
    for (device, title) in [(&core, "From Mac"), (&peer, "From iPad")] {
        let receipt = bank::edit(device, module.clone(), serde_json::from_value(json!({"kind":"newQuestion", "title":title})).unwrap()).unwrap();
        question_ids.insert(receipt.question_id);
    }
    replicate(&core, &peer, &module, 3);
    replicate(&peer, &core, &module, 5);
    let merged = bank::get(&core, module.clone()).unwrap().unwrap();
    assert_eq!(merged.questions.keys().cloned().collect::<HashSet<_>>(), question_ids);
    assert_eq!(bank::get(&peer, module).unwrap(), Some(merged));
}

#[test]
fn note_writes_continue_while_synced_worksheet_files_are_still_downloading() {
    let (_dir, core, module) = core();
    let value = fixture();
    let bank: Bank = serde_json::from_value(value.clone()).unwrap();
    assets(&core, &module, &bank);
    let doc = document(&value);
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    // Like a peer that received the content but not yet the files.
    core.db.lock().unwrap().execute("delete from files", []).unwrap();
    use yrs::XmlFragment;
    doc.get_or_insert_xml_fragment("default")
        .push_back(&mut doc.transact_mut(), yrs::XmlTextPrelim::new("Typed in the note"));
    content::add_update(&core.db, module.clone(), bytes(&doc)).unwrap();
    content::save_compaction(&core.db, module.clone(), bytes(&doc), i64::MAX).unwrap();
}
