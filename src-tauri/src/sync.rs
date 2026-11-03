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
    generation: String,
) -> CommandResult<Vec<OutboxEntry>> {
    let result = memnoter_core::sync::sync_outbox(&core.db, limit_bytes, generation)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_ack(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    max_id: i64,
    generation: String,
) -> CommandResult<()> {
    memnoter_core::sync::sync_ack(&core.db, max_id, generation)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_set_cursor(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    cursor: i64,
    generation: String,
) -> CommandResult<()> {
    memnoter_core::sync::sync_set_cursor(&core.db, cursor, generation)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_apply(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    entries: Vec<RemoteEntry>,
    cursor: i64,
    generation: String,
) -> CommandResult<ApplyResult> {
    let result =
        memnoter_core::sync::sync_apply(core.data_dir(), &core.db, entries, cursor, generation)?;
    if !result.deleted.is_empty() {
        let _ = app.emit("sync-outbox", ());
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_snapshot(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    doc: String,
    generation: String,
) -> CommandResult<Option<Vec<u8>>> {
    let result = memnoter_core::sync::sync_snapshot(&core.db, doc, generation)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_missing_files(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    generation: String,
) -> CommandResult<Vec<MissingFile>> {
    let result = memnoter_core::sync::sync_missing_files(&core.db, generation)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_pending_uploads(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    generation: String,
) -> CommandResult<Vec<String>> {
    let result = memnoter_core::sync::sync_pending_uploads(&core.db, generation)?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_upload_done(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    file_id: String,
    generation: String,
) -> CommandResult<()> {
    memnoter_core::sync::sync_upload_done(&core.db, file_id, generation)?;
    Ok(())
}

#[tauri::command(async)]
pub fn sync_store_file(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    file_id: String,
    module_id: String,
    file_type: String,
    bytes: Vec<u8>,
    generation: String,
) -> CommandResult<crate::FileType> {
    let result = memnoter_core::sync::sync_store_file(
        core.data_dir(),
        &core.db,
        file_id,
        module_id,
        file_type,
        bytes,
        generation,
    )?;
    Ok(result)
}

#[tauri::command(async)]
pub fn sync_reconcile(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    generation: String,
) -> CommandResult<ApplyResult> {
    let result = memnoter_core::sync::sync_reconcile(core.data_dir(), &core.db, generation)?;
    Ok(result)
}
