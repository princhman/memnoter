//! JSON-lines command bridge for browser integration tests. Always ephemeral.
use std::io::{BufRead, Write};
fn main() {
    let dir = std::env::temp_dir().join(format!("memnoter-harness-{}", std::process::id()));
    let core = memnoter_core::Core::open(&dir).expect("temporary core");
    let development = std::env::args().any(|arg| arg == "--question-bank-dev");
    if development {
        let path = dir.canonicalize().unwrap();
        std::fs::write(
            path.join(memnoter_core::worksheets::bank::DEV_MARKER),
            path.to_string_lossy().as_bytes(),
        )
        .unwrap();
        std::env::set_var("MEMNOTER_DATA_DIR", &path);
        std::env::set_var("MEMNOTER_QUESTION_BANK_DEV", "1");
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let command = request["command"].as_str().unwrap();
        let args = &request["args"];
        let result = match command {
            "local_backup_markdown_hash" => Ok(serde_json::json!(
                memnoter_core::markdown_backup::markdown_hash(args["markdown"].as_str().unwrap())
            )),
            "write_local_backup" => {
                let folder = std::path::Path::new(args["folder"].as_str().unwrap());
                let snapshot = serde_json::from_value(args["snapshot"].clone()).unwrap();
                memnoter_core::markdown_backup::write(&dir, folder, snapshot)
                    .map(|warnings| serde_json::json!(warnings))
                    .map_err(serde_json::Value::String)
            }
            "read_local_backup_edits" => {
                let folder = std::path::Path::new(args["folder"].as_str().unwrap());
                memnoter_core::markdown_backup::edited_files(&dir, folder)
                    .map(|edits| serde_json::json!(edits))
                    .map_err(serde_json::Value::String)
            }
            _ => memnoter_core::dispatch(&core, command, &args.to_string())
                .map(|value| serde_json::from_str(&value).unwrap())
                .map_err(|error| serde_json::json!(error)),
        };
        let response = match result {
            Ok(value) => {
                serde_json::json!({"value": value})
            }
            Err(error) => serde_json::json!({"error": error}),
        };
        println!("{response}");
        std::io::stdout().flush().unwrap();
    }
    drop(core);
    if !std::env::args().any(|arg| arg == "--keep") {
        std::fs::remove_dir_all(dir).expect("remove temporary database and images");
    }
}
