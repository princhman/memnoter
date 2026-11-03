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
    let source = include_str!("../../../src-tauri/src/lib.rs");
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
