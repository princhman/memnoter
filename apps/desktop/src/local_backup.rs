use memnoter_core::{markdown_backup, CommandResult, Core};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::State;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    folder: Option<PathBuf>,
    enabled: bool,
}

#[derive(Default)]
pub(crate) struct BackupGate(Mutex<()>);

fn settings_path(core: &Core) -> PathBuf {
    core.data_dir().join("local-markdown-backup.json")
}

fn read(core: &Core) -> CommandResult<Settings> {
    match fs::read(settings_path(core)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn update(
    core: &Core,
    gate: &BackupGate,
    change: impl FnOnce(&mut Settings),
) -> CommandResult<Settings> {
    let _guard = gate.0.lock().map_err(|error| error.to_string())?;
    let mut settings = read(core)?;
    change(&mut settings);
    let bytes = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
    markdown_backup::write_if_changed(&settings_path(core), &bytes)?;
    Ok(settings)
}

#[tauri::command(async)]
pub(crate) fn pick_local_backup_folder(
    core: State<'_, std::sync::Arc<Core>>,
    gate: State<'_, std::sync::Arc<BackupGate>>,
) -> CommandResult<Settings> {
    let Some(folder) = rfd::FileDialog::new()
        .set_title("Choose backup folder")
        .pick_folder()
    else {
        return read(&core);
    };
    let folder = folder.canonicalize().map_err(|error| error.to_string())?;
    let data = core
        .data_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if folder.starts_with(data) {
        return Err("Choose a folder outside Memnoter's app data".into());
    }
    update(&core, &gate, |settings| settings.folder = Some(folder))
}

pub(crate) fn dispatch(
    core: &Core,
    gate: &BackupGate,
    command: &str,
    args: serde_json::Value,
) -> CommandResult<serde_json::Value> {
    #[derive(Deserialize)]
    struct WriteRequest {
        folder: PathBuf,
        snapshot: markdown_backup::Snapshot,
    }
    let format = |settings| serde_json::to_value(settings).map_err(|error| error.to_string());
    match command {
        "local_backup_image_types" => serde_json::to_value(markdown_backup::image_types(&core.db)?)
            .map_err(|error| error.to_string()),
        "local_backup_settings" => format(read(core)?),
        "set_local_backup_enabled" => {
            let enabled = args["enabled"]
                .as_bool()
                .ok_or("Expected backup enabled state")?;
            format(update(core, gate, |settings| {
                settings.enabled = enabled && settings.folder.is_some()
            })?)
        }
        "write_local_backup" => {
            let request: WriteRequest =
                serde_json::from_value(args).map_err(|error| error.to_string())?;
            let _guard = gate.0.lock().map_err(|error| error.to_string())?;
            let settings = read(core)?;
            if settings.enabled && settings.folder.as_ref() == Some(&request.folder) {
                markdown_backup::write(core.data_dir(), &request.folder, request.snapshot)?;
            }
            Ok(serde_json::Value::Null)
        }
        _ => Err("Unknown local backup command".into()),
    }
}
