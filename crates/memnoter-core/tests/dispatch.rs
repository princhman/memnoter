use memnoter_core::{dispatch, Core, DATA_COMMANDS};
use serde_json::{json, Value};
use std::collections::BTreeSet;

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

// Independent desktop registration is the public transport inventory. This
// fails if a command is added to either transport alone; module qualifiers and
// whitespace do not affect the contract.
#[test]
fn dispatch_and_desktop_register_the_same_data_commands() {
    let source = include_str!("../../../apps/desktop/src/lib.rs");
    let handler = source
        .split("tauri::generate_handler![")
        .nth(1)
        .unwrap()
        .split("])")
        .next()
        .unwrap()
        .lines()
        .filter(|line| !line.trim().starts_with("#["))
        .collect::<Vec<_>>()
        .join("\n");
    let registered: BTreeSet<_> = handler
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.rsplit("::").next().unwrap())
        .filter(|name| {
            !matches!(
                *name,
                "set_editor_history" | "confirm_exit" | "confirm_restart"
            )
        })
        .collect();
    let accepted: BTreeSet<_> = DATA_COMMANDS.iter().copied().collect();
    assert_eq!(registered, accepted);
    let fixture = Fixture::new();
    for command in DATA_COMMANDS {
        assert!(!dispatch(&fixture.core, command, "{}")
            .unwrap_or_else(|e| e)
            .starts_with("Unknown command:"));
    }
    assert_eq!(
        dispatch(&fixture.core, "absent", "invalid JSON"),
        Err("Unknown command: absent".into())
    );
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
    );
    assert_eq!(f.call("due_cards", json!({"now":0})), json!([])); // omitted Option follows Tauri
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
         alter table review_log drop column sync_id;",
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
