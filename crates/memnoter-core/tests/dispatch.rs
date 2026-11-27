use memnoter_core::{dispatch, Core, CoreError};
use serde_json::{json, Value};

struct Fixture {
    core: Core,
    dir: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("memnoter-dispatch-{}", uuid::Uuid::new_v4()));
        Self {
            core: Core::open(&dir).unwrap(),
            dir,
        }
    }
    fn call(&self, command: &str, args: Value) -> Value {
        serde_json::from_str(&dispatch(&self.core, command, &args.to_string()).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn frontend_payloads_keep_camel_case_bytes_null_and_storage_errors() {
    let f = Fixture::new();
    let id = f.call("create_module", json!({"name":"Portable"}));
    assert!(id.is_string());
    assert_eq!(
        f.call(
            "set_module_numbering",
            json!({"moduleId":id,"enabled":true})
        ),
        Value::Null
    );
    assert_eq!(
        f.call("modules", json!({})),
        json!([{"id":id,"name":"Portable","heading_numbering":true}])
    );
    let update = f.call("add_update", json!({"moduleId":id,"bytes":[0,0]}));
    assert_eq!(update["bytes"], json!([0, 0]));
    assert_eq!(
        f.call(
            "save_compaction",
            json!({"moduleId":id,"newState":[0,0],"updateId":update["id"]})
        ),
        Value::Null
    );
    let file = f.call(
        "save_file",
        json!({"moduleId":id,"bytes":[0,127,255],"mimeType":"image/png"}),
    );
    assert_eq!(file["file_type"], "image/png");
    assert_eq!(
        f.call("read_file", json!({"moduleId":id,"fileId":file["id"]})),
        json!({"bytes":[0,127,255],"file_type":"image/png"})
    );
    let content = f.call("get_content", json!({"moduleId":id}));
    assert_eq!(content, json!({"state":[0,0],"updates":[],"files":[file]}));
    assert_eq!(
        f.call(
            "index_note",
            json!({"moduleId":id,"body":"needle","math":"","version":1,"backfill":false})
        ),
        Value::Null
    );
    assert_eq!(
        f.call("search_notes", json!({"query":"needle","limit":10}))[0]["module_id"],
        id
    );
    let invalid_file = json!({"moduleId":id,"fileId":"invalid"});
    assert_eq!(
        dispatch(&f.core, "read_file", &invalid_file.to_string()),
        memnoter_core::read_file(
            f.core.data_dir(),
            &f.core.db,
            id.as_str().unwrap().into(),
            "invalid".into()
        )
        .map(|_| unreachable!())
        .map_err(CoreError::from)
    );
    assert_eq!(f.call("due_cards", json!({"now":0})), json!([])); // omitted Option follows Tauri
    f.call(
        "sync_cards",
        json!({"moduleId":id,"cards":[{"id":"card","kind":"basic","front":[],"back":[]}]}),
    );
    let now = i64::MAX - 1;
    assert_eq!(
        f.call("due_cards", json!({"now":now}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.call("due_cards", json!({"now":now,"createdAtCutoff":0})),
        json!([])
    );
    assert_eq!(
        f.call(
            "due_counts",
            json!({"now":now,"dayEnd":now,"createdAtCutoff":0})
        ),
        json!([])
    );
    assert_eq!(
        f.call(
            "due_counts",
            json!({"now":now,"dayEnd":now,"createdAtCutoff":null})
        )[0]["new"],
        1
    );
    assert_eq!(f.call("delete_module", json!({"moduleId":id})), Value::Null);
    assert_eq!(f.call("modules", json!({})), json!([]));
}

#[test]
fn sync_dispatch_upgrades_existing_database_and_applies_to_fresh_device() {
    let a = Fixture::new();
    let id = a.call("create_module", json!({"name":"Before sync"}));
    // Model an existing desktop schema before the sync migration.
    a.core
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "drop table sync_outbox; drop table sync_state; drop table sync_docs;
         drop table sync_file_uploads; drop index review_log_sync_id;
         alter table review_log drop column sync_id; PRAGMA user_version = 0;",
        )
        .unwrap();
    let upgraded = Core::open(&a.dir).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&dispatch(&upgraded, "sync_status", "{}").unwrap()).unwrap(),
        json!({"account":null,"cursor":0,"pending":0,"generation":a.call("sync_status", json!({}))["generation"]})
    );
    a.call("sync_enable", json!({"account":"account-json"}));
    a.call("rename_module", json!({"moduleId":id,"name":"After sync"}));
    a.call("add_update", json!({"moduleId":id,"bytes":[0,0]}));
    let entries = a.call(
        "sync_outbox",
        json!({"limitBytes":1000000,"generation":a.call("sync_status", json!({}))["generation"]}),
    );
    let entries: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(seq, entry)| json!({"seq":seq+1,"doc":entry["doc"],"bytes":entry["bytes"]}))
        .collect();
    let b = Fixture::new();
    b.call("sync_enable", json!({"account":"account-json"}));
    b.call(
        "sync_apply",
        json!({"entries":entries,"cursor":entries.len(),"generation":b.call("sync_status", json!({}))["generation"]}),
    );
    assert_eq!(b.call("modules", json!({}))[0]["name"], "After sync");
    assert_eq!(
        b.call("get_content", json!({"moduleId":id}))["updates"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["bytes"],
        json!([0, 0])
    );
    // Reopening an already-upgraded DB is idempotent and keeps sync state.
    let reopened = Core::open(&b.dir).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&dispatch(&reopened, "sync_status", "{}").unwrap()).unwrap()
            ["cursor"],
        entries.len()
    );
}

#[test]
fn restore_rejects_old_ack_and_cursor_without_losing_seeded_uploads() {
    let f = Fixture::new();
    f.call("create_module", json!({"name":"Restored note"}));
    let backup = f.call("backup_now", json!({})); // sync-off snapshot
    f.call("sync_enable", json!({"account":"account"}));
    let old = f.call("sync_status", json!({}))["generation"].clone();
    f.call("restore_backup", json!({"id":backup["id"]}));
    let before = f.call("sync_status", json!({}));
    assert_ne!(before["generation"], old);
    assert_eq!(before["cursor"], 0);
    assert_eq!(before["pending"], 1);
    for (command, args) in [
        ("sync_ack", json!({"maxId":11,"generation":old})),
        ("sync_set_cursor", json!({"cursor":100,"generation":old})),
        (
            "sync_apply",
            json!({"entries":[],"cursor":100,"generation":old}),
        ),
        (
            "sync_upload_done",
            json!({"fileId":"image","generation":old}),
        ),
        (
            "sync_store_file",
            json!({"fileId":"invalid","moduleId":"note","fileType":"png","bytes":[1],"generation":old}),
        ),
        ("sync_reconcile", json!({"generation":old})),
    ] {
        assert_eq!(
            dispatch(&f.core, command, &args.to_string()),
            Err("SYNC_STALE_GENERATION".into())
        );
    }
    assert_eq!(f.call("sync_status", json!({})), before);
    let current = before["generation"].clone();
    f.call(
        "sync_set_cursor",
        json!({"cursor":100,"generation":current}),
    );
    f.call("sync_ack", json!({"maxId":11,"generation":current}));
    assert_eq!(f.call("sync_status", json!({}))["pending"], 0);
    assert_eq!(f.call("sync_status", json!({}))["cursor"], 100);
    f.call("sync_enable", json!({"account":"account"}));
    assert_ne!(f.call("sync_status", json!({}))["generation"], current);
    let signed_in = f.call("sync_status", json!({}))["generation"].clone();
    f.call("sync_disable", json!({}));
    assert_ne!(f.call("sync_status", json!({}))["generation"], signed_in);
}

#[test]
fn committed_outbox_writes_notify_once_without_holding_the_database_lock() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let f = Fixture::new();
    let core = Arc::new(Core::open(&f.dir).unwrap());
    let weak = Arc::downgrade(&core);
    let notifications = Arc::new(AtomicUsize::new(0));
    let received = notifications.clone();
    core.set_outbox_callback(Arc::new(move || {
        // A host may synchronously read status when receiving the signal.
        dispatch(&weak.upgrade().unwrap(), "sync_status", "{}").unwrap();
        received.fetch_add(1, Ordering::SeqCst);
    }));
    dispatch(&core, "create_module", r#"{"name":"Offline"}"#).unwrap();
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
    dispatch(&core, "sync_enable", r#"{"account":"account"}"#).unwrap();
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
    let id: Value = serde_json::from_str(
        &dispatch(
            &core,
            "import_module",
            r#"{"name":"Imported","bytes":[0,0],"images":[]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        notifications.load(Ordering::SeqCst),
        2,
        "multiple outbox rows produce one signal"
    );
    dispatch(
        &core,
        "set_module_numbering",
        &json!({"moduleId":id,"enabled":true}).to_string(),
    )
    .unwrap();
    assert_eq!(notifications.load(Ordering::SeqCst), 2);
    {
        let mut conn = core.db.lock().unwrap();
        let tx = conn.transaction().unwrap();
        memnoter_core::sync::record_update(&tx, id.as_str().unwrap(), &[0, 0]).unwrap();
        tx.rollback().unwrap();
    }
    assert_eq!(
        notifications.load(Ordering::SeqCst),
        2,
        "rollback must not nudge sync"
    );
    dispatch(&core, "delete_module", &json!({"moduleId":id}).to_string()).unwrap();
    assert_eq!(notifications.load(Ordering::SeqCst), 3);
    let backup: Value =
        serde_json::from_str(&dispatch(&core, "backup_now", "{}").unwrap()).unwrap();
    dispatch(
        &core,
        "restore_backup",
        &json!({"id":backup["id"]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        notifications.load(Ordering::SeqCst),
        4,
        "restored outbox must be sent"
    );
}

#[test]
fn dispatch_errors_have_stable_codes_and_user_visible_messages() {
    let f = Fixture::new();
    let error = dispatch(&f.core, "sync_ack", r#"{"maxId":1,"generation":"expired"}"#).unwrap_err();
    assert_eq!(error, CoreError::StaleGeneration);
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({"code":"stale_generation","message":"SYNC_STALE_GENERATION"})
    );
    let error = dispatch(&f.core, "absent", "{}").unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({"code":"storage","message":"Unknown command: absent"})
    );
}

#[test]
fn sync_identity_scrubs_secrets_before_backup_and_preserves_outbox() {
    let f = Fixture::new();
    let account = json!({"server":"https://sync.example/","userId":"u", "key":"RAW_KEY_SENTINEL_93746", "token":"RAW_TOKEN_SENTINEL_93746"}).to_string();
    f.call("sync_enable", json!({"account":account}));
    let before = f.call("sync_status", json!({}));
    f.call(
        "sync_set_cursor",
        json!({"cursor":42,"generation":before["generation"]}),
    );
    f.call(
        "sync_enable",
        json!({"account":json!({"server":"https://sync.example","userId":"u"}).to_string()}),
    );
    let after = f.call("sync_status", json!({}));
    assert_eq!(after["cursor"], 42);
    assert_eq!(after["pending"], before["pending"]);
    let identity: Value = serde_json::from_str(after["account"].as_str().unwrap()).unwrap();
    assert_eq!(
        identity,
        json!({"server":"https://sync.example","userId":"u"})
    );
    f.call("backup_now", json!({}));
    fn inspect(dir: &std::path::Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                inspect(&path);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                for secret in [
                    b"RAW_KEY_SENTINEL_93746".as_slice(),
                    b"RAW_TOKEN_SENTINEL_93746".as_slice(),
                ] {
                    assert!(
                        !bytes.windows(secret.len()).any(|window| window == secret),
                        "Secret in {}",
                        path.display()
                    );
                }
            }
        }
    }
    inspect(&f.dir.join("backups"));
}

#[test]
fn sidebar_order_folders_and_membership_survive_reopen_and_folder_deletion() {
    let f = Fixture::new();
    let module = f.call("create_module", json!({"name":"Algebra"}));
    let folder = json!({"id":"folder-study","name":"Study","folder_id":null,"sort_order":2,"collapsed":true,"deleted":false});
    let note = json!({"id":module,"name":null,"folder_id":"folder-study","sort_order":1,"collapsed":false,"deleted":false});
    f.call("save_sidebar_items", json!({"items":[folder, note]}));
    let reopened = Core::open(&f.dir).unwrap();
    let items: Value =
        serde_json::from_str(&dispatch(&reopened, "sidebar_items", "{}").unwrap()).unwrap();
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert!(items.as_array().unwrap().contains(&folder));
    assert!(items.as_array().unwrap().contains(&note));
    let mut deleted = folder.clone();
    deleted["deleted"] = json!(true);
    f.call("save_sidebar_items", json!({"items":[deleted]}));
    assert_eq!(f.call("modules", json!({}))[0]["id"], module);
    assert!(dispatch(
        &f.core,
        "save_sidebar_items",
        &json!({"items":[folder]}).to_string()
    )
    .is_err());
}

#[test]
fn sidebar_table_is_added_to_existing_version_3_database() {
    let f = Fixture::new();
    f.core
        .db
        .lock()
        .unwrap()
        .execute_batch("drop table sidebar_items; PRAGMA user_version = 3;")
        .unwrap();
    let upgraded = Core::open(&f.dir).unwrap();
    assert_eq!(dispatch(&upgraded, "sidebar_items", "{}").unwrap(), "[]");
}

#[test]
fn synced_module_with_files_deletes_after_upgrading_a_version_6_database() {
    let f = Fixture::new();
    let module = f.call("create_module", json!({"name":"Drawings"}));
    f.call(
        "save_file",
        json!({"moduleId":module,"bytes":[1,2,3],"mimeType":"image/png"}),
    );
    f.call("sync_enable", json!({"account":"{}"}));
    // A database that reached version 6 before these sync tables existed.
    f.core
        .db
        .lock()
        .unwrap()
        .execute_batch(
            "drop table sync_files_gone; drop table sync_file_deletes; PRAGMA user_version = 6;",
        )
        .unwrap();
    let upgraded = Core::open(&f.dir).unwrap();
    dispatch(&upgraded, "delete_module", &json!({"moduleId":module}).to_string()).unwrap();
    assert_eq!(dispatch(&upgraded, "modules", "{}").unwrap(), "[]");
}

#[test]
fn sidebar_changes_sync_including_seeded_folders_and_deletion() {
    let source = Fixture::new();
    let target = Fixture::new();
    let module = source.call("create_module", json!({"name":"Math"}));
    let folder = json!({"id":"folder-math","name":"Math folder","folder_id":null,"sort_order":0,"collapsed":false,"deleted":false});
    let note = json!({"id":module,"name":null,"folder_id":"folder-math","sort_order":3,"collapsed":false,"deleted":false});
    source.call("save_sidebar_items", json!({"items":[folder, note]}));
    source.call("sync_enable", json!({"account":"{}"}));
    target.call("sync_enable", json!({"account":"{}"}));
    let source_gen = source.call("sync_status", json!({}))["generation"].clone();
    let target_gen = target.call("sync_status", json!({}))["generation"].clone();
    let transfer = || {
        let snapshot = source.call(
            "sync_snapshot",
            json!({"doc":"vault","generation":source_gen}),
        );
        target.call("sync_apply", json!({"entries":[{"doc":"vault","bytes":snapshot,"seq":1}],"cursor":1,"generation":target_gen}));
    };
    transfer();
    assert_eq!(
        target.call("sidebar_items", json!({})),
        source.call("sidebar_items", json!({}))
    );
    assert_eq!(target.call("modules", json!({}))[0]["id"], module);
    let mut changed = note.clone();
    changed["folder_id"] = Value::Null;
    changed["sort_order"] = json!(9);
    source.call("save_sidebar_items", json!({"items":[changed]}));
    let mut deleted = folder.clone();
    deleted["deleted"] = json!(true);
    source.call("save_sidebar_items", json!({"items":[deleted]}));
    transfer();
    assert_eq!(
        target.call("sidebar_items", json!({})),
        source.call("sidebar_items", json!({}))
    );
    assert_eq!(
        target.call("modules", json!({})).as_array().unwrap().len(),
        1
    );
}

#[test]
fn invalid_sidebar_batch_is_atomic() {
    let f = Fixture::new();
    let folder = json!({"id":"folder-valid","name":"Valid","folder_id":null,"sort_order":0,"collapsed":false,"deleted":false});
    let invalid = json!({"id":"folder-invalid","name":"Invalid","folder_id":"folder-valid","sort_order":1,"collapsed":false,"deleted":false});
    assert!(dispatch(
        &f.core,
        "save_sidebar_items",
        &json!({"items":[folder, invalid]}).to_string()
    )
    .is_err());
    assert_eq!(f.call("sidebar_items", json!({})), json!([]));
}

#[test]
fn saved_images_are_announced_downloaded_and_not_echoed_as_uploads() {
    let a = Fixture::new();
    let b = Fixture::new();
    let module = a.call("create_module", json!({"name":"Images"}));
    let first = a.call(
        "save_file",
        json!({"moduleId":module,"bytes":[1,2,3],"mimeType":"image/png"}),
    );
    a.call("sync_enable", json!({"account":"{}"}));
    b.call("sync_enable", json!({"account":"{}"}));
    let ga = a.call("sync_status", json!({}))["generation"].clone();
    let gb = b.call("sync_status", json!({}))["generation"].clone();
    assert_eq!(
        a.call("sync_pending_uploads", json!({"generation":ga})),
        json!([first["id"]])
    );
    let later = a.call(
        "save_file",
        json!({"moduleId":module,"bytes":[4,5,6],"mimeType":"image/jpeg"}),
    );
    let uploads = a.call("sync_pending_uploads", json!({"generation":ga}));
    assert_eq!(uploads.as_array().unwrap().len(), 2);
    assert!(uploads.as_array().unwrap().contains(&later["id"]));
    let entries = a.call("sync_outbox", json!({"limitBytes":1048576,"generation":ga}));
    let remote: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, e)| json!({"seq":i+1,"doc":e["doc"],"bytes":e["bytes"]}))
        .collect();
    b.call(
        "sync_apply",
        json!({"entries":remote,"cursor":remote.len(),"generation":gb}),
    );
    let missing = b.call("sync_missing_files", json!({"generation":gb}));
    assert_eq!(missing.as_array().unwrap().len(), 2);
    assert!(missing
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["fileId"] == later["id"]));
    b.call("sync_store_file", json!({"fileId":later["id"],"moduleId":module,"fileType":"image/jpeg","bytes":[4,5,6],"generation":gb}));
    assert_eq!(
        b.call("read_file", json!({"fileId":later["id"],"moduleId":module}))["bytes"],
        json!([4, 5, 6])
    );
    assert_eq!(
        b.call("sync_missing_files", json!({"generation":gb}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        b.call("sync_pending_uploads", json!({"generation":gb})),
        json!([])
    );
}

#[test]
fn drawing_source_and_preview_survive_a_second_device_edit_and_restart() {
    use yrs::{
        updates::decoder::Decode, GetString, ReadTxn, Transact, Update, Xml, XmlElementPrelim,
        XmlFragment,
    };

    fn transfer(from: &Fixture, to: &Fixture, cursor: &mut i64) {
        let generation = from.call("sync_status", json!({}))["generation"].clone();
        let rows = from.call(
            "sync_outbox",
            json!({"generation":generation,"limitBytes":1048576}),
        );
        let entries: Vec<_> = rows
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                *cursor += 1;
                json!({"seq":*cursor,"doc":row["doc"],"bytes":row["bytes"]})
            })
            .collect();
        to.call("sync_apply", json!({"entries":entries,"cursor":cursor,"generation":to.call("sync_status", json!({}))["generation"]}));
        if let Some(last) = rows.as_array().unwrap().last() {
            from.call(
                "sync_ack",
                json!({"maxId":last["id"],"generation":generation}),
            );
        }
    }
    fn reopen_note(fixture: &Fixture, module: &Value) -> yrs::Doc {
        let content = fixture.call("get_content", json!({"moduleId":module}));
        let doc = yrs::Doc::new();
        let mut txn = doc.transact_mut();
        for bytes in std::iter::once(&content["state"]).chain(
            content["updates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| &row["bytes"]),
        ) {
            let bytes: Vec<u8> = serde_json::from_value(bytes.clone()).unwrap();
            if !bytes.is_empty() {
                txn.apply_update(Update::decode_v1(&bytes).unwrap())
                    .unwrap();
            }
        }
        drop(txn);
        doc
    }

    let ipad = Fixture::new();
    let desktop = Fixture::new();
    let module = ipad.call("create_module", json!({"name":"Drawing round trip"}));
    for device in [&ipad, &desktop] {
        device.call("sync_enable", json!({"account":"drawing-test"}));
    }
    // The core transports opaque source data; actual PencilKit decoding belongs
    // to the native managed-source test, and schema retention to the web test.
    let source_bytes = include_bytes!("../../../apps/ios/Tests/Fixtures/portable-drawing.json").to_vec();
    let source = ipad.call("save_file", json!({"moduleId":module,"bytes":source_bytes,"mimeType":"application/vnd.memnoter.drawing+json"}));
    let preview = ipad.call(
        "save_file",
        json!({"moduleId":module,"bytes":[137,80,78,71,13,10,26,10],"mimeType":"image/png"}),
    );
    let reference = json!({"version":1,"sourceId":source["id"],"previewId":preview["id"]});
    let doc = yrs::Doc::new();
    let root = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let image = root.insert(&mut txn, 0, XmlElementPrelim::empty("image"));
    image.insert_attribute(&mut txn, "fileId", preview["id"].as_str().unwrap());
    image.insert_attribute(
        &mut txn,
        "drawing",
        yrs::Any::from_json(&reference.to_string()).unwrap(),
    );
    let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    ipad.call("add_update", json!({"moduleId":module,"bytes":state}));
    let mut cursor = 0;
    transfer(&ipad, &desktop, &mut cursor);
    let generation = desktop.call("sync_status", json!({}))["generation"].clone();
    let missing = desktop.call("sync_missing_files", json!({"generation":generation}));
    assert_eq!(missing.as_array().unwrap().len(), 2);
    for asset in [&source, &preview] {
        let entry = missing
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["fileId"] == asset["id"])
            .unwrap();
        assert_eq!(entry["fileType"], asset["file_type"]);
        let file = ipad.call("read_file", json!({"moduleId":module,"fileId":asset["id"]}));
        desktop.call("sync_store_file", json!({"generation":generation,"moduleId":module,"fileId":asset["id"],"fileType":entry["fileType"],"bytes":file["bytes"]}));
    }
    assert_eq!(
        desktop.call("sync_missing_files", json!({"generation":generation})),
        json!([])
    );
    assert_eq!(
        desktop.call("sync_pending_uploads", json!({"generation":generation})),
        json!([])
    );

    let edited = reopen_note(&desktop, &module);
    let root = edited.get_or_insert_xml_fragment("default");
    let before = edited.transact().state_vector();
    let mut txn = edited.transact_mut();
    let paragraph = root.insert(&mut txn, 1, XmlElementPrelim::empty("paragraph"));
    paragraph.insert(&mut txn, 0, yrs::XmlTextPrelim::new("Edited on Mac"));
    let update = txn.encode_state_as_update_v1(&before);
    drop(txn);
    desktop.call("add_update", json!({"moduleId":module,"bytes":update}));
    transfer(&desktop, &ipad, &mut cursor);
    let returned = reopen_note(&ipad, &module);
    let root = returned.get_or_insert_xml_fragment("default");
    let txn = returned.transact();
    let image = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
    let yrs::Out::Any(drawing) = image.get_attribute(&txn, "drawing").unwrap() else {
        panic!("lost drawing attribute")
    };
    let mut json = String::new();
    drawing.to_json(&mut json);
    assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), reference);
    assert!(root.get_string(&txn).contains("Edited on Mac"));
    let restarted = Core::open(&desktop.dir).unwrap();
    let bytes: Value = serde_json::from_str(
        &dispatch(
            &restarted,
            "read_file",
            &json!({"moduleId":module,"fileId":source["id"]}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(bytes["bytes"], json!(source_bytes));
    let backup = desktop.call("backup_now", json!({}));
    let backup_path = desktop.dir.join("backups").join(backup["id"].as_str().unwrap());
    assert_eq!(std::fs::read(backup_path.join("files").join(source["id"].as_str().unwrap())).unwrap(), source_bytes);
    desktop.call("restore_backup", json!({"id":backup["id"]}));
    assert_eq!(desktop.call("read_file", json!({"moduleId":module,"fileId":source["id"]}))["bytes"], json!(source_bytes));
    let restored = reopen_note(&desktop, &module);
    let restored_root = restored.get_or_insert_xml_fragment("default");
    assert!(restored_root.get_string(&restored.transact()).contains(source["id"].as_str().unwrap()));
}

#[test]
fn document_commands_keep_typed_frontend_payloads_and_local_availability() {
    let f = Fixture::new();
    let module = f.call("create_module", json!({"name":"PDFs"}));
    let document = f.call(
        "add_document_bytes",
        json!({"moduleId":module,"name":"Book.pdf","bytes":b"%PDF-1.7".to_vec()}),
    );
    assert_eq!(document["moduleName"], "PDFs");
    assert_eq!(document["available"], true);
    assert_eq!(document["pageCount"], Value::Null);
    assert_eq!(f.call("list_documents", json!({})), json!([document]));
    let id = &document["id"];
    assert_eq!(
        f.call("rename_document", json!({"id":id,"name":"New.pdf"})),
        Value::Null
    );
    assert_eq!(
        f.call("set_document_page_count", json!({"id":id,"pageCount":4})),
        Value::Null
    );
    let path = f.call("document_path", json!({"id":id}));
    std::fs::remove_file(path.as_str().unwrap()).unwrap();
    let listed = f.call("list_documents", json!({"moduleId":module}));
    assert_eq!(listed[0]["available"], false);
    assert_eq!(listed[0]["pageCount"], 4);
    assert_eq!(listed[0]["name"], "New.pdf");
    assert!(dispatch(&f.core, "document_path", &json!({"id":id}).to_string()).is_err());
    assert_eq!(f.call("delete_document", json!({"id":id})), Value::Null);
    assert_eq!(f.call("list_documents", json!({})), json!([]));
}

fn transfer_vault(sender: &Fixture, receiver: &Fixture, seq: i32) {
    let sender_gen = sender.call("sync_status", json!({}))["generation"].clone();
    let receiver_gen = receiver.call("sync_status", json!({}))["generation"].clone();
    let vault = sender.call("sync_snapshot", json!({"doc":"vault","generation":sender_gen}));
    receiver.call("sync_apply", json!({
        "entries":[{"doc":"vault","bytes":vault,"seq":seq}],
        "cursor":seq,"generation":receiver_gen
    }));
}

#[test]
fn file_order_survives_restart_and_syncs_in_both_directions() {
    let source = Fixture::new();
    let target = Fixture::new();
    let module = source.call("create_module", json!({"name":"Algebra"}));
    let other = source.call("create_module", json!({"name":"Geometry"}));
    let add = |module: &Value, name: &str| {
        source.call("add_document_bytes", json!({
            "moduleId":module, "name":name, "bytes":b"%PDF-"
        }))["id"].clone()
    };
    let first = add(&module, "First.pdf");
    let second = add(&other, "Second.pdf");
    let third = add(&module, "Third.pdf");
    let move_file = |fixture: &Fixture, id: &Value, target_id: &Value, after: bool| {
        fixture.call("move_document", json!({"id":id,"targetId":target_id,"after":after}));
    };
    let ids = |documents: Value| -> Vec<Value> {
        documents.as_array().unwrap().iter().map(|doc| doc["id"].clone()).collect()
    };
    move_file(&source, &third, &first, false);
    let reopened = Core::open(&source.dir).unwrap();
    let list = |fixture: &Fixture| ids(fixture.call("list_documents", json!({})));
    assert_eq!(
        ids(serde_json::from_str(&dispatch(&reopened, "list_documents", "{}").unwrap()).unwrap()),
        [&third, &first, &second].map(Clone::clone)
    );
    drop(reopened);

    source.call("sync_enable", json!({"account":"{}"}));
    target.call("sync_enable", json!({"account":"{}"}));
    let generation = source.call("sync_status", json!({}))["generation"].clone();
    source.call("sync_outbox", json!({"limitBytes":1048576,"generation":generation}));
    transfer_vault(&source, &target, 1);
    assert_eq!(list(&target), [&third, &first, &second].map(Clone::clone));
    assert_eq!(
        ids(target.call("list_documents", json!({"moduleId":module}))),
        [&third, &first].map(Clone::clone)
    );

    move_file(&target, &first, &second, true);
    transfer_vault(&target, &source, 2);
    assert_eq!(list(&source), [&third, &second, &first].map(Clone::clone));
    let new = add(&module, "New.pdf");
    source.call("delete_document", json!({"id":third}));
    transfer_vault(&source, &target, 3);
    assert_eq!(list(&target), [&second, &first, &new].map(Clone::clone));
}

#[test]
fn enabling_sync_keeps_the_vaults_newer_file_order() {
    use yrs::{updates::decoder::Decode, Doc, Map, Transact, Update};

    let a = Fixture::new();
    let b = Fixture::new();
    let module = a.call("create_module", json!({"name":"PDFs"}));
    let add = |name: &str| {
        a.call("add_document_bytes", json!({
            "moduleId":module, "name":name, "bytes":b"%PDF-"
        }))["id"].clone()
    };
    let first = add("First.pdf");
    let second = add("Second.pdf");
    a.call("sync_enable", json!({"account":"{}"}));
    b.call("sync_enable", json!({"account":"{}"}));
    transfer_vault(&a, &b, 1);
    b.call("sync_disable", json!({}));
    b.call("move_document", json!({"id":second,"targetId":first,"after":false}));
    a.call("move_document", json!({"id":first,"targetId":second,"after":false}));

    b.call("sync_enable", json!({"account":"{}"}));
    transfer_vault(&a, &b, 2);
    let generation = b.call("sync_status", json!({}))["generation"].clone();
    let entries = b.call("sync_outbox", json!({"limitBytes":1048576,"generation":generation}));
    let upload = Doc::new();
    let order = upload.get_or_insert_map("document-order");
    for entry in entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["doc"] == "vault")
    {
        let bytes: Vec<u8> = serde_json::from_value(entry["bytes"].clone()).unwrap();
        upload
            .transact_mut()
            .apply_update(Update::decode_v1(&bytes).unwrap())
            .unwrap();
    }
    assert!(
        order.get(&upload.transact(), "ids").is_none(),
        "seed must not publish the stale order"
    );
    transfer_vault(&b, &a, 3);
    for device in [&a, &b] {
        let documents = device.call("list_documents", json!({}));
        assert_eq!([&documents[0]["id"], &documents[1]["id"]], [&first, &second]);
    }
}

#[test]
fn deleted_pdf_is_removed_from_arrival_order_on_both_devices() {
    let a = Fixture::new();
    let b = Fixture::new();
    let module = a.call("create_module", json!({"name":"PDFs"}));
    let id = a.call("add_document_bytes", json!({
        "moduleId":module, "name":"First.pdf", "bytes":b"%PDF-"
    }))["id"].clone();
    a.call("sync_enable", json!({"account":"{}"}));
    b.call("sync_enable", json!({"account":"{}"}));
    transfer_vault(&a, &b, 1);
    let arrivals = |device: &Fixture| -> Value {
        let data: String = rusqlite::Connection::open(device.dir.join("main.db"))
            .unwrap()
            .query_row("select arrivals from document_order where id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        serde_json::from_str(&data).unwrap()
    };
    assert_eq!([arrivals(&a), arrivals(&b)], [json!([id]), json!([id])]);

    a.call("delete_document", json!({"id":id}));
    transfer_vault(&a, &b, 2);
    assert_eq!([arrivals(&a), arrivals(&b)], [json!([]), json!([])]);
}

#[test]
fn synced_pdf_from_an_earlier_clock_appends_to_local_arrival_order() {
    let a = Fixture::new();
    let b = Fixture::new();
    let module = a.call("create_module", json!({"name":"PDFs"}));
    let add = |fixture: &Fixture, name: &str| {
        fixture.call("add_document_bytes", json!({
            "moduleId":module, "name":name, "bytes":b"%PDF-"
        }))["id"].clone()
    };
    a.call("sync_enable", json!({"account":"{}"}));
    b.call("sync_enable", json!({"account":"{}"}));
    transfer_vault(&a, &b, 1);

    let existing = add(&a, "Existing.pdf");
    // Advance A's import clock without changing the machine clock for both cores.
    rusqlite::Connection::open(a.dir.join("main.db"))
        .unwrap()
        .execute("update documents set created_at = created_at + 86400000", [])
        .unwrap();
    a.call("rename_document", json!({"id":existing,"name":"Existing renamed.pdf"}));
    let new = add(&b, "New.pdf");
    let list = |fixture: &Fixture| -> Vec<Value> {
        fixture.call("list_documents", json!({})).as_array().unwrap()
            .iter().map(|doc| doc["id"].clone()).collect()
    };
    transfer_vault(&b, &a, 2);
    assert_eq!(list(&a), [&existing, &new].map(Clone::clone));
    transfer_vault(&a, &b, 3);
    assert_eq!(list(&b), [&new, &existing].map(Clone::clone));
    transfer_vault(&b, &a, 4);
    assert_eq!(list(&a), [&existing, &new].map(Clone::clone));
}

#[test]
fn receiving_an_import_before_its_reorder_does_not_publish_an_order() {
    let a = Fixture::new();
    let b = Fixture::new();
    let module = a.call("create_module", json!({"name":"PDFs"}));
    let add = |name: &str| {
        a.call("add_document_bytes", json!({
            "moduleId":module, "name":name, "bytes":b"%PDF-"
        }))["id"].clone()
    };
    let existing = add("Existing.pdf");
    a.call("sync_enable", json!({"account":"{}"}));
    b.call("sync_enable", json!({"account":"{}"}));
    let generation = b.call("sync_status", json!({}))["generation"].clone();
    transfer_vault(&a, &b, 1);
    let outbox = || b.call("sync_outbox", json!({"limitBytes":1048576,"generation":generation}));
    let before_import = outbox();

    let new = add("New.pdf");
    transfer_vault(&a, &b, 2);
    let after_import = outbox();
    a.call("move_document", json!({"id":new,"targetId":existing,"after":false}));
    transfer_vault(&a, &b, 3);
    transfer_vault(&b, &a, 4);
    transfer_vault(&a, &b, 5);

    assert_eq!(after_import.as_array().unwrap().len(), before_import.as_array().unwrap().len(),
        "receiving a PDF must not queue an order update");
    for device in [&a, &b] {
        let documents = device.call("list_documents", json!({}));
        assert_eq!([&documents[0]["id"], &documents[1]["id"]], [&new, &existing]);
    }
}
