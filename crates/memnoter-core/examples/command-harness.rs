//! JSON-lines command bridge for browser integration tests. Always ephemeral.
use std::io::{BufRead, Write};
fn main() {
    let dir = std::env::temp_dir().join(format!("memnoter-harness-{}", std::process::id()));
    let core = memnoter_core::Core::open(&dir).expect("temporary core");
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let result = memnoter_core::dispatch(
            &core,
            request["command"].as_str().unwrap(),
            &request["args"].to_string(),
        );
        let response = match result {
            Ok(value) => {
                serde_json::json!({"value": serde_json::from_str::<serde_json::Value>(&value).unwrap()})
            }
            Err(error) => serde_json::json!({"error": error}),
        };
        println!("{response}");
        std::io::stdout().flush().unwrap();
    }
    drop(core);
    std::fs::remove_dir_all(dir).expect("remove temporary database and images");
}
