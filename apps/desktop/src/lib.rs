use memnoter_core::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
mod backups;
mod cards;
mod import_folder;
#[cfg(target_os = "macos")]
mod menu;
mod sync;
#[cfg(target_os = "macos")]
mod selection_limit;
#[derive(Default)]
struct ExitGate(AtomicBool);
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    app.state::<ExitGate>().0.store(true, Ordering::SeqCst);
    app.exit(0);
}

// Restarts skip ExitRequested's prevent_exit, so the frontend must have
// finished its save checks before calling this.
#[tauri::command]
fn confirm_restart(app: tauri::AppHandle) {
    app.state::<ExitGate>().0.store(true, Ordering::SeqCst);
    app.restart();
}

#[tauri::command]
fn set_module_numbering(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    enabled: bool,
) -> CommandResult<()> {
    memnoter_core::set_module_numbering(&core.db, module_id, enabled)
}
#[tauri::command]
fn create_module(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    name: String,
) -> CommandResult<String> {
    let result = memnoter_core::create_module(&core.db, name)?;
    let _ = app.emit("sync-outbox", ());
    Ok(result)
}
#[tauri::command(async)]
fn import_module(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    name: String,
    bytes: Vec<u8>,
    images: Vec<ImportImage>,
) -> CommandResult<String> {
    let result = memnoter_core::import_module(core.data_dir(), &core.db, name, bytes, images)?;
    let _ = app.emit("sync-outbox", ());
    Ok(result)
}
#[tauri::command]
fn modules(core: tauri::State<'_, std::sync::Arc<Core>>) -> CommandResult<Vec<Module>> {
    memnoter_core::modules(&core.db)
}
#[tauri::command]
fn rename_module(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    name: String,
) -> CommandResult<()> {
    memnoter_core::rename_module(&core.db, module_id, name)?;
    let _ = app.emit("sync-outbox", ());
    Ok(())
}
#[tauri::command(async)]
fn delete_module(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
) -> CommandResult<()> {
    memnoter_core::delete_module(core.data_dir(), &core.db, module_id)?;
    let _ = app.emit("sync-outbox", ());
    Ok(())
}
#[tauri::command(async)]
fn get_content(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
) -> CommandResult<GetContentResponse> {
    memnoter_core::get_content(&core.db, module_id)
}
#[tauri::command(async)]
fn add_update(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    bytes: Vec<u8>,
) -> CommandResult<ContentUpdate> {
    let result = memnoter_core::add_update(&core.db, module_id, bytes)?;
    let _ = app.emit("sync-outbox", ());
    Ok(result)
}
#[tauri::command(async)]
fn save_compaction(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    new_state: Vec<u8>,
    update_id: i64,
) -> CommandResult<()> {
    memnoter_core::save_compaction(&core.db, module_id, new_state, update_id)
}
#[tauri::command(async)]
fn save_file(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> CommandResult<FileType> {
    let result = memnoter_core::save_file(core.data_dir(), &core.db, module_id, bytes, mime_type)?;
    let _ = app.emit("sync-outbox", ());
    Ok(result)
}
#[tauri::command(async)]
fn read_file(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    file_id: String,
) -> CommandResult<FileContents> {
    memnoter_core::read_file(core.data_dir(), &core.db, module_id, file_id)
}
#[tauri::command]
fn resolve_card_image(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    file_id: String,
) -> CommandResult<String> {
    memnoter_core::resolve_card_image(core.data_dir(), &core.db, file_id)
}
#[tauri::command(async)]
fn cleanup_files(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    file_ids: Vec<String>,
    expected_state: Vec<u8>,
    expected_update_id: i64,
) -> CommandResult<Vec<String>> {
    memnoter_core::cleanup_files(
        core.data_dir(),
        &core.db,
        module_id,
        file_ids,
        expected_state,
        expected_update_id,
    )
}
#[tauri::command(async)]
fn index_note(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    body: String,
    math: String,
    version: i64,
    backfill: bool,
) -> CommandResult<()> {
    memnoter_core::index_note(&core.db, module_id, body, math, version, backfill)
}
#[tauri::command(async)]
fn unindexed_modules(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    version: i64,
) -> CommandResult<Vec<String>> {
    memnoter_core::unindexed_modules(&core.db, version)
}
#[tauri::command(async)]
fn search_notes(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    query: String,
    limit: i64,
) -> CommandResult<Vec<SearchResult>> {
    memnoter_core::search_notes(&core.db, query, limit)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle_event);

    // iOS apps update through the App Store and can't restart themselves.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let core = std::sync::Arc::new(
                Core::open({
                    #[cfg(debug_assertions)]
                    if let Some(dir) = std::env::var_os("MEMNOTER_DATA_DIR") {
                        std::path::PathBuf::from(dir)
                    } else {
                        app.path().app_data_dir()?
                    }
                    #[cfg(not(debug_assertions))]
                    app.path().app_data_dir()?
                })
                .expect("Failed to init db."),
            );
            #[cfg(debug_assertions)]
            if std::env::var_os("MEMNOTER_DATA_DIR").is_some() {
                app.asset_protocol_scope()
                    .allow_directory(core.data_dir().join("files"), true)?;
            }
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| selection_limit::limit_attributed_substrings(webview.inner()))?;
            }
            app.manage(core.clone());
            app.manage(ExitGate::default());
            memnoter_core::backups::spawn_daily_backup(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            menu::set_editor_history,
            confirm_exit,
            confirm_restart,
            create_module,
            import_module,
            import_folder::pick_import_folder,
            modules,
            get_content,
            add_update,
            rename_module,
            set_module_numbering,
            delete_module,
            save_compaction,
            save_file,
            read_file,
            cleanup_files,
            resolve_card_image,
            cards::sync_cards,
            cards::unindexed_card_modules,
            cards::due_cards,
            cards::due_counts,
            cards::review_card,
            cards::undo_review,
            cards::card_schedules,
            index_note,
            unindexed_modules,
            search_notes,
            backups::list_backups,
            backups::backup_now,
            backups::restore_backup,
            sync::sync_status,
            sync::sync_enable,
            sync::sync_disable,
            sync::sync_outbox,
            sync::sync_ack,
            sync::sync_set_cursor,
            sync::sync_apply,
            sync::sync_snapshot,
            sync::sync_missing_files,
            sync::sync_pending_uploads,
            sync::sync_upload_done,
            sync::sync_store_file,
            sync::sync_reconcile
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitGate>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Err(error) = app.emit("request-safe-exit", ()) {
                        eprintln!("Unable to request safe exit: {error}");
                    }
                }
            }
        });
}
