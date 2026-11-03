use super::*;
use memnoter_core::backups::*;
#[tauri::command(async)]
pub(crate) fn list_backups(app: tauri::AppHandle) -> CommandResult<Vec<Backup>> {
    memnoter_core::backups::list_backups(&app.path().app_data_dir().map_err(|e| e.to_string())?)
}
#[tauri::command(async)]
pub(crate) fn backup_now(app: tauri::AppHandle, db: tauri::State<'_, Db>) -> CommandResult<Backup> {
    memnoter_core::backups::backup_now(&app.path().app_data_dir().map_err(|e| e.to_string())?, &db)
}
#[tauri::command(async)]
pub(crate) fn restore_backup(
    app: tauri::AppHandle, db: tauri::State<'_, Db>, id: String) -> CommandResult<()> {
    memnoter_core::backups::restore_backup(&app.path().app_data_dir().map_err(|e| e.to_string())?, &db, id)
}
