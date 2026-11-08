use memnoter_core::{dispatch, Core};
use serde_json::{json, Value};
use yrs::{updates::decoder::Decode, Any, Doc, Map, Out, ReadTxn, StateVector, Transact, Update};

struct Device {
    core: Core,
    dir: std::path::PathBuf,
}
impl Device {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("pdf-annotations-{}", uuid::Uuid::new_v4()));
        Self {
            core: Core::open(&dir).unwrap(),
            dir,
        }
    }
    fn call(&self, command: &str, args: Value) -> Value {
        serde_json::from_str(&dispatch(&self.core, command, &args.to_string()).unwrap()).unwrap()
    }
    fn error(&self, command: &str, args: Value) -> String {
        dispatch(&self.core, command, &args.to_string())
            .unwrap_err()
            .to_string()
    }
    fn generation(&self) -> Value {
        self.call("sync_status", json!({}))["generation"].clone()
    }
    fn enable(&self) {
        self.call("sync_enable", json!({"account":"test-account"}));
    }
    fn pdf(&self) -> (Value, Value) {
        let module = self.call("create_module", json!({"name":"PDF owner"}));
        let pdf = self.call("add_document_bytes", json!({"moduleId":module,"name":"original.pdf","bytes":b"%PDF-1.7\noriginal bytes".to_vec()}));
        (module, pdf["id"].clone())
    }
    fn load(&self, id: &Value) -> Value {
        self.call("load_annotations", json!({"documentId":id}))
    }
    fn save(&self, id: &Value, bytes: Vec<u8>) -> Value {
        self.call(
            "save_annotation_update",
            json!({"documentId":id,"bytes":bytes,"generation":self.load(id)["generation"]}),
        )
    }
    fn snapshot(&self) -> Vec<u8> {
        serde_json::from_value(self.call(
            "sync_snapshot",
            json!({"doc":"vault","generation":self.generation()}),
        ))
        .unwrap()
    }
    fn apply(&self, bytes: Vec<u8>, cursor: i64) -> Value {
        self.call("sync_apply", json!({"entries":[{"seq":cursor,"doc":"vault","bytes":bytes}],"cursor":cursor,"generation":self.generation()}))
    }
    fn count(&self, table: &str) -> i64 {
        self.core
            .db
            .lock()
            .unwrap()
            .query_row(&format!("select count(*) from {table}"), [], |r| r.get(0))
            .unwrap()
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
fn decode(bytes: &[u8]) -> Doc {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(bytes).unwrap())
        .unwrap();
    doc
}
fn receipt_doc(receipt: Value) -> Doc {
    decode(&serde_json::from_value::<Vec<u8>>(receipt["state"].clone()).unwrap())
}
fn edit(doc: &Doc, key: &str, value: &str) -> Vec<u8> {
    doc.get_or_insert_map("annotations")
        .insert(&mut doc.transact_mut(), key, value);
    encode(doc)
}
fn contains(doc: &Doc, key: &str) -> bool {
    doc.get_or_insert_map("annotations")
        .get(&doc.transact(), key)
        .is_some()
}

#[test]
fn lazy_reads_invalid_bytes_retry_and_restart_offline() {
    let mut a = Device::new();
    let (_, id) = a.pdf();
    let empty = a.load(&id);
    assert_eq!(empty["state"], Value::Null);
    assert_eq!(empty["revision"], 0);
    assert_eq!(a.count("pdf_annotations"), 0);
    assert_eq!(a.count("sync_outbox"), 0);
    assert!(a
        .error(
            "save_annotation_update",
            json!({"documentId":id,"bytes":[255],"generation":empty["generation"]})
        )
        .contains("Invalid PDF annotation"));
    assert_eq!(a.count("pdf_annotations"), 0);
    let doc = Doc::new();
    let update = edit(&doc, "a", "highlight");
    let saved = a.save(&id, update.clone());
    assert_eq!(a.save(&id, update), saved); // response-loss retry
    a.enable();
    let published = a.snapshot();
    let pending = a.count("sync_outbox");
    a.save(&id, encode(&doc));
    assert_eq!(a.count("sync_outbox"), pending);
    a.call("sync_disable", json!({}));
    assert_eq!(a.load(&id), saved); // account toggles retain runtime generation
    a.core = Core::open(&a.dir).unwrap();
    assert_ne!(a.load(&id)["generation"], saved["generation"]);
    assert!(a
        .error(
            "save_annotation_update",
            json!({"documentId":id,"bytes":encode(&doc),"generation":saved["generation"]})
        )
        .contains("ANNOTATION_STALE_GENERATION"));
    a.enable();
    let b = Device::new();
    b.enable();
    b.apply(a.snapshot(), 1);
    assert!(contains(&receipt_doc(b.load(&id)), "a"));
    assert!(!published.is_empty());
}

#[test]
fn concurrent_checkpoints_and_deletion_only_history_merge_in_both_orders() {
    for reverse in [false, true] {
        let a = Device::new();
        let b = Device::new();
        let (_, id) = a.pdf();
        a.enable();
        b.enable();
        b.apply(a.snapshot(), 1);
        let initial = Doc::new();
        a.save(&id, edit(&initial, "old", "remove me"));
        b.apply(a.snapshot(), 2);
        let da = receipt_doc(a.load(&id));
        let db = receipt_doc(b.load(&id));
        da.get_or_insert_map("annotations")
            .remove(&mut da.transact_mut(), "old");
        a.save(&id, encode(&da));
        b.save(&id, edit(&db, "new", "concurrent"));
        let sa = a.snapshot();
        let sb = b.snapshot();
        if reverse {
            b.apply(sa, 3);
            a.apply(sb, 3);
        } else {
            a.apply(sb, 3);
            b.apply(sa, 3);
        }
        for device in [&a, &b] {
            let doc = receipt_doc(device.load(&id));
            assert!(!contains(&doc, "old"));
            assert!(contains(&doc, "new"));
        }
        let pending = a.count("sync_outbox");
        a.apply(b.snapshot(), 4);
        assert_eq!(a.count("sync_outbox"), pending); // receive never republishes
        let next = receipt_doc(a.load(&id));
        a.save(&id, edit(&next, "third", "consolidate"));
        let vault = decode(&a.snapshot());
        assert_eq!(
            vault
                .get_or_insert_map("pdfAnnotationUpdatesV1")
                .len(&vault.transact()),
            1
        );
        a.call("sync_disable", json!({}));
        a.enable();
        b.apply(a.snapshot(), 5);
        assert!(!contains(&receipt_doc(b.load(&id)), "old"));
    }
}

#[test]
fn pdf_module_and_server_gone_defeat_late_updates() {
    for deletion in ["pdf", "module", "gone"] {
        let a = Device::new();
        let b = Device::new();
        let (module, id) = a.pdf();
        a.enable();
        b.enable();
        b.apply(a.snapshot(), 1);
        let doc = Doc::new();
        b.save(&id, edit(&doc, "late", "stale offline edit"));
        match deletion {
            "pdf" => {
                a.call("delete_document", json!({"id":id}));
            }
            "module" => {
                a.call("delete_module", json!({"moduleId":module}));
            }
            _ => {
                a.call(
                    "sync_file_gone",
                    json!({"fileId":id,"generation":a.generation()}),
                );
            }
        }
        a.apply(b.snapshot(), 2);
        assert_eq!(a.count("pdf_annotations"), 0);
        assert_eq!(a.count("pdf_annotation_tombstones"), 1);
        let result = b.apply(a.snapshot(), 3);
        assert_eq!(result["annotationsChanged"], json!([id]));
        assert_eq!(b.count("pdf_annotations"), 0);
        a.call("sync_disable", json!({}));
        a.enable();
        assert_eq!(a.count("pdf_annotation_tombstones"), 1);
        b.apply(a.snapshot(), 4);
        assert_eq!(b.count("pdf_annotations"), 0);
    }
}

#[test]
fn malformed_known_vault_payload_rolls_back_metadata_and_cursor() {
    let a = Device::new();
    let b = Device::new();
    let (_, id) = a.pdf();
    a.enable();
    b.enable();
    for value in [
        Any::Buffer(vec![255].into()),
        Any::String("bad type".into()),
    ] {
        let vault = decode(&a.snapshot());
        vault.get_or_insert_map("pdfAnnotationUpdatesV1").insert(
            &mut vault.transact_mut(),
            format!("{}/{}", id.as_str().unwrap(), uuid::Uuid::new_v4()),
            value,
        );
        assert!(b.error("sync_apply", json!({"entries":[{"seq":9,"doc":"vault","bytes":encode(&vault)}],"cursor":9,"generation":b.generation()})).contains("Invalid PDF annotation"));
        assert_eq!(b.call("sync_status", json!({}))["cursor"], 0);
        assert_eq!(b.count("documents"), 0);
        assert_eq!(b.count("pdf_annotations"), 0);
    }
}

#[test]
fn old_vault_unknown_maps_survive_seed_snapshot_and_annotation_write() {
    let a = Device::new();
    let (module, id) = a.pdf();
    a.enable();
    let vault = decode(&a.snapshot());
    vault.get_or_insert_map("futureOpaqueMap").insert(
        &mut vault.transact_mut(),
        "future",
        Any::Buffer(vec![1, 2, 3].into()),
    );
    a.apply(encode(&vault), 1);
    a.call("rename_module", json!({"moduleId":module,"name":"renamed"}));
    a.save(&id, edit(&Doc::new(), "a", "hello"));
    let result = decode(&a.snapshot());
    assert_eq!(
        result
            .get_or_insert_map("futureOpaqueMap")
            .get(&result.transact(), "future"),
        Some(Out::Any(Any::Buffer(vec![1, 2, 3].into())))
    );
}

#[test]
fn backups_restore_rows_bytes_generation_and_same_account_reseed() {
    let a = Device::new();
    let (_, id) = a.pdf();
    a.enable();
    let doc = Doc::new();
    let saved = a.save(&id, edit(&doc, "kept", "saved"));
    let outbox = a.call(
        "sync_outbox",
        json!({"limitBytes":10000000,"generation":a.generation()}),
    );
    let max_id = outbox.as_array().unwrap().last().unwrap()["id"].clone();
    a.call(
        "sync_ack",
        json!({"maxId":max_id,"generation":a.generation()}),
    );
    assert_eq!(a.count("sync_outbox"), 0);
    let backup = a.call("backup_now", json!({}));
    let backup_dir = a.dir.join("backups").join(backup["id"].as_str().unwrap());
    let backed = rusqlite::Connection::open(backup_dir.join("main.db")).unwrap();
    assert_eq!(
        backed
            .query_row("select count(*) from pdf_annotations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        std::fs::read(backup_dir.join("files").join(id.as_str().unwrap())).unwrap(),
        b"%PDF-1.7\noriginal bytes"
    );
    a.save(&id, edit(&doc, "later", "later"));
    a.call("restore_backup", json!({"id":backup["id"]}));
    let restored_outbox = a.call(
        "sync_outbox",
        json!({"limitBytes":10000000,"generation":a.generation()}),
    );
    assert!(restored_outbox
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["doc"] == "vault"));
    assert_ne!(a.load(&id)["generation"], saved["generation"]);
    assert!(a
        .error(
            "save_annotation_update",
            json!({"documentId":id,"bytes":encode(&doc),"generation":saved["generation"]})
        )
        .contains("ANNOTATION_STALE_GENERATION"));
    let b = Device::new();
    b.enable();
    b.apply(a.snapshot(), 1);
    assert!(contains(&receipt_doc(b.load(&id)), "kept"));
    a.call("delete_document", json!({"id":id}));
    a.call("restore_backup", json!({"id":backup["id"]}));
    assert_eq!(a.count("pdf_annotations"), 0);
    assert_eq!(a.count("pdf_annotation_tombstones"), 1);
    b.apply(a.snapshot(), 2);
    assert_eq!(b.count("pdf_annotations"), 0);
}

#[test]
fn tombstone_only_state_survives_off_restart_enable_and_late_creation() {
    let mut a = Device::new();
    let b = Device::new();
    let (_, id) = a.pdf();
    a.enable();
    b.enable();
    b.apply(a.snapshot(), 1);
    let annotation = uuid::Uuid::new_v4().to_string();
    let removed = Doc::new();
    removed.get_or_insert_map("pdfAnnotationDeletions").insert(
        &mut removed.transact_mut(),
        annotation.as_str(),
        true,
    );
    a.save(&id, encode(&removed));
    a.call("sync_disable", json!({}));
    a.core = Core::open(&a.dir).unwrap();
    a.enable();
    let late = Doc::new();
    late.get_or_insert_map("pdfAnnotations").insert(
        &mut late.transact_mut(),
        annotation.as_str(),
        "late creation",
    );
    b.save(&id, encode(&late));
    let late_state = b.snapshot();
    b.apply(a.snapshot(), 2);
    a.apply(late_state, 2);
    for device in [&a, &b] {
        let doc = receipt_doc(device.load(&id));
        assert_eq!(
            doc.get_or_insert_map("pdfAnnotationDeletions")
                .get(&doc.transact(), &annotation),
            Some(Out::Any(Any::Bool(true)))
        );
        assert!(doc
            .get_or_insert_map("pdfAnnotations")
            .contains_key(&doc.transact(), &annotation));
    }
}

#[test]
fn checkpoints_wait_for_metadata_and_concurrent_comment_text_merges() {
    use yrs::{GetString, Text};
    let a = Device::new();
    let b = Device::new();
    let (_, id) = a.pdf();
    a.enable();
    b.enable();
    let annotation = Doc::new();
    annotation
        .get_or_insert_text("body")
        .insert(&mut annotation.transact_mut(), 0, "middle");
    let orphan_vault = Doc::new();
    orphan_vault
        .get_or_insert_map("pdfAnnotationUpdatesV1")
        .insert(
            &mut orphan_vault.transact_mut(),
            format!("{}/{}", id.as_str().unwrap(), uuid::Uuid::new_v4()),
            Any::Buffer(encode(&annotation).into()),
        );
    b.apply(encode(&orphan_vault), 1);
    assert_eq!(b.count("pdf_annotations"), 0);
    b.apply(a.snapshot(), 2);
    assert_eq!(b.count("pdf_annotations"), 1);
    a.apply(b.snapshot(), 3);
    let da = receipt_doc(a.load(&id));
    let db = receipt_doc(b.load(&id));
    da.get_or_insert_text("body")
        .insert(&mut da.transact_mut(), 0, "left ");
    db.get_or_insert_text("body")
        .insert(&mut db.transact_mut(), 6, " right");
    a.save(&id, encode(&da));
    b.save(&id, encode(&db));
    let sa = a.snapshot();
    a.apply(b.snapshot(), 4);
    b.apply(sa, 4);
    for device in [&a, &b] {
        let doc = receipt_doc(device.load(&id));
        assert_eq!(
            doc.get_or_insert_text("body").get_string(&doc.transact()),
            "left middle right"
        );
    }
}

#[test]
fn canonical_receipts_retain_out_of_order_pending_structs() {
    let a = Device::new();
    let (_, id) = a.pdf();
    let doc = Doc::new();
    let first = edit(&doc, "first", "dependency");
    let vector = doc.transact().state_vector();
    edit(&doc, "second", "arrived first");
    let incremental = doc.transact().encode_state_as_update_v1(&vector);
    let pending = a.save(&id, incremental);
    assert!(receipt_doc(pending).transact().has_missing_updates());
    let result = receipt_doc(a.save(&id, first));
    assert!(contains(&result, "first"));
    assert!(contains(&result, "second"));
}
