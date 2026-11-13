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
    assert!(content::save_compaction(&core.db, module, Vec::new(), i64::MAX).is_err());
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
