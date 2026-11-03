use super::*;
use memnoter_core::sync::*;

#[tauri::command(async)]
pub fn sync_status(core: tauri::State<'_, std::sync::Arc<Core>>) -> CommandResult<SyncStatus> {
    let result = memnoter_core::sync::sync_status(&core.db)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_enable(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    account: String,
) -> CommandResult<()> {
    memnoter_core::sync::sync_enable(&core.db, account)?;
    let _ = app.emit("sync-outbox", ());
    Ok(())
}

#[tauri::command(async)]
pub fn sync_disable(core: tauri::State<'_, std::sync::Arc<Core>>) -> CommandResult<()> {
    memnoter_core::sync::sync_disable(&core.db)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_outbox(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    limit_bytes: i64,
) -> CommandResult<Vec<OutboxEntry>> {
    let result = memnoter_core::sync::sync_outbox(&core.db, limit_bytes)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_ack(core: tauri::State<'_, std::sync::Arc<Core>>, max_id: i64) -> CommandResult<()> {
    memnoter_core::sync::sync_ack(&core.db, max_id)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_set_cursor(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    cursor: i64,
) -> CommandResult<()> {
    memnoter_core::sync::sync_set_cursor(&core.db, cursor)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_apply(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    entries: Vec<RemoteEntry>,
    cursor: i64,
) -> CommandResult<ApplyResult> {
    let result = memnoter_core::sync::sync_apply(core.data_dir(), &core.db, entries, cursor)?;
    if !result.deleted.is_empty() {
        let _ = app.emit("sync-outbox", ());
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_snapshot(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    doc: String,
) -> CommandResult<Option<Vec<u8>>> {
    let result = memnoter_core::sync::sync_snapshot(&core.db, doc)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_missing_files(
    core: tauri::State<'_, std::sync::Arc<Core>>,
) -> CommandResult<Vec<MissingFile>> {
    let result = memnoter_core::sync::sync_missing_files(&core.db)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_pending_uploads(
    core: tauri::State<'_, std::sync::Arc<Core>>,
) -> CommandResult<Vec<String>> {
    let result = memnoter_core::sync::sync_pending_uploads(&core.db)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_upload_done(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    file_id: String,
) -> CommandResult<()> {
    memnoter_core::sync::sync_upload_done(&core.db, file_id)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_store_file(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    file_id: String,
    module_id: String,
    file_type: String,
    bytes: Vec<u8>,
) -> CommandResult<crate::FileType> {
    let result = memnoter_core::sync::sync_store_file(
        core.data_dir(),
        &core.db,
        file_id,
        module_id,
        file_type,
        bytes,
    )?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_reconcile(core: tauri::State<'_, std::sync::Arc<Core>>) -> CommandResult<ApplyResult> {
    let result = memnoter_core::sync::sync_reconcile(core.data_dir(), &core.db)?;
    Ok(result)
}
