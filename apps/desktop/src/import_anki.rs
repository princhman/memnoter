use memnoter_core::{anki::{OpenedPackage, Sessions}, CommandResult};
use std::sync::{Mutex, OnceLock};

static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();

#[tauri::command(async)]
pub(crate) fn pick_anki_package() -> CommandResult<Option<OpenedPackage>> {
    rfd::FileDialog::new().set_title("Import Anki deck").add_filter("Anki package", &["apkg"])
        .pick_file().map(|path| {
            SESSIONS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?.open(&path)
        }).transpose()
}
#[tauri::command(async)]
pub(crate) fn read_anki_media(source_id: String, names: Vec<String>) -> CommandResult<Vec<Vec<u8>>> {
    SESSIONS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?.read_media(&source_id, &names)
}
#[tauri::command(async)]
pub(crate) fn close_anki_package(source_id: String) -> CommandResult<()> {
    SESSIONS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?.close(&source_id);
    Ok(())
}
