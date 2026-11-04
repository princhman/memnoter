use super::*;
use memnoter_core::backups::*;
#[tauri::command(async)]
pub(crate) fn list_backups(
    core: tauri::State<'_, std::sync::Arc<Core>>,
) -> CommandResult<Vec<Backup>> {
    memnoter_core::backups::list_backups(core.data_dir())
}
#[tauri::command(async)]
pub(crate) fn backup_now(core: tauri::State<'_, std::sync::Arc<Core>>) -> CommandResult<Backup> {
    memnoter_core::backups::backup_now(core.data_dir(), &core.db)
}
#[tauri::command(async)]
pub(crate) fn restore_backup(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    id: String,
) -> CommandResult<()> {
    memnoter_core::backups::restore_backup(core.data_dir(), &core.db, id)
}
