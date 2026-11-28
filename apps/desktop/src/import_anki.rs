use memnoter_core::{
    anki::{OpenedPackage, Sessions},
    CommandResult, Core,
};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Request, Response};

static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();

#[tauri::command(async)]
pub(crate) fn pick_anki_package() -> CommandResult<Option<OpenedPackage>> {
    rfd::FileDialog::new()
        .set_title("Import Anki deck")
        .add_filter("Anki package", &["apkg"])
        .pick_file()
        .map(|path| {
            SESSIONS
                .get_or_init(Default::default)
                .lock()
                .map_err(|e| e.to_string())?
                .open(&path)
        })
        .transpose()
}
#[tauri::command(async)]
pub(crate) fn read_anki_media(source_id: String, names: Vec<String>) -> CommandResult<Response> {
    let images = SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .read_media(&source_id, &names)?;
    let mut packed = Vec::with_capacity(images.iter().map(|bytes| 4 + bytes.len()).sum());
    for bytes in images {
        packed.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        packed.extend_from_slice(&bytes);
    }
    Ok(Response::new(packed))
}

#[tauri::command]
pub(crate) async fn import_anki_module(
    state: tauri::State<'_, std::sync::Arc<Core>>,
    request: Request<'_>,
) -> CommandResult<String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary Anki import payload".into());
    };
    let bytes = bytes.clone();
    let core = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || memnoter_core::import_binary_module(&core, &bytes))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command(async)]
pub(crate) fn close_anki_package(source_id: String) -> CommandResult<()> {
    SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .close(&source_id);
    Ok(())
}
