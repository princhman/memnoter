use memnoter_core::{Core, CoreError};
use std::sync::Arc;

#[tauri::command]
pub(crate) async fn pick_pdfs(
    state: tauri::State<'_, Arc<Core>>,
    module_id: String,
) -> Result<Vec<Result<serde_json::Value, String>>, CoreError> {
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let paths = rfd::FileDialog::new()
            .set_title("Add PDFs")
            .add_filter("PDF", &["pdf"])
            .pick_files()
            .unwrap_or_default();
        paths
            .into_iter()
            .map(|path| {
                let args =
                    serde_json::json!({ "moduleId": module_id, "path": path.to_string_lossy() });
                memnoter_core::dispatch(&core, "add_document", &args.to_string())
                    .map_err(|e| e.to_string())
                    .and_then(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            })
            .collect()
    })
    .await
    .map_err(|e| CoreError::Storage(e.to_string()))
}
