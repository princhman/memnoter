use memnoter_core::{Core, CoreError};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
mod import_folder;
mod import_anki;
mod pdf_picker;
#[cfg(target_os = "macos")]
mod local_backup;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod selection_limit;
mod spelling;
mod sync_credentials;
#[cfg(target_os = "macos")]
mod drawing;
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
async fn core(
    state: tauri::State<'_, std::sync::Arc<Core>>,
    app: tauri::AppHandle,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, CoreError> {
    let core = state.inner().clone();
    #[cfg(target_os = "macos")]
    let backup_gate = app
        .state::<std::sync::Arc<local_backup::BackupGate>>()
        .inner()
        .clone();
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        match command.as_str() {
            "sync_credentials_save" => {
                sync_credentials::save(&core, &args["account"])?;
                return Ok(serde_json::Value::Null);
            }
            "sync_credentials_load" => return sync_credentials::load(&core),
            "sync_credentials_delete" => {
                sync_credentials::delete(&core)?;
                return Ok(serde_json::Value::Null);
            }
            #[cfg(target_os = "macos")]
            "local_backup_settings"
            | "local_backup_image_types"
            | "local_backup_markdown_hash"
            | "set_local_backup_enabled"
            | "set_local_backup_layout"
            | "read_local_backup_edits"
            | "resolve_local_backup_edits"
            | "write_local_backup" => {
                return local_backup::dispatch(&core, &backup_gate, &command, args)
                    .map_err(CoreError::Storage);
            }
            _ => {}
        }
        let result = memnoter_core::dispatch(&core, &command, &args.to_string())?;
        serde_json::from_str(&result).map_err(|e| CoreError::Storage(e.to_string()))
    })
    .await
    .map_err(|e| CoreError::Storage(e.to_string()))?
}

pub fn run() {
    let context = tauri::generate_context!();
    spelling::apply_saved_language(&context.config().identifier);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.manage(drawing::DrawingGate::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle_event);

    // iOS apps update through the App Store and can't restart themselves.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.app_handle().state::<ExitGate>().0.load(Ordering::SeqCst) {
                    // Keep the webview alive until its existing safe-exit flow
                    // has flushed edits. Otherwise ExitRequested can leave a
                    // process with no window and no handler to finish exiting.
                    api.prevent_close();
                    #[cfg(target_os = "macos")]
                    drawing::close(window.app_handle());
                    if let Err(error) = window.emit("request-safe-exit", ()) {
                        eprintln!("Unable to request safe window close: {error}");
                    }
                }
            }
        })
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
                window.with_webview(|webview| {
                    selection_limit::limit_attributed_substrings(webview.inner())
                })?;
            }
            sync_credentials::migrate(&core)?;
            let handle = app.handle().clone();
            core.set_outbox_callback(std::sync::Arc::new(move || {
                if let Err(error) = handle.emit(memnoter_core::sync::OUTBOX_EVENT, ()) {
                    eprintln!("Unable to announce sync outbox: {error}");
                }
            }));
            #[cfg(target_os = "macos")]
            app.manage(std::sync::Arc::new(local_backup::BackupGate::default()));
            app.manage(core.clone());
            app.manage(ExitGate::default());
            memnoter_core::backups::spawn_daily_backup(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            drawing::edit_drawing,
            #[cfg(target_os = "macos")]
            drawing::drawing_committed,
            #[cfg(target_os = "macos")]
            menu::set_editor_history,
            confirm_exit,
            confirm_restart,
            core,
            #[cfg(target_os = "macos")]
            local_backup::pick_local_backup_folder,
            import_folder::pick_import_folder,
            import_folder::pick_import_image_folder,
            import_anki::pick_anki_package,
            import_anki::read_anki_media,
            import_anki::close_anki_package,
            pdf_picker::pick_pdfs,
            spelling::check_spelling,
            spelling::add_to_dictionary,
            spelling::spelling_languages,
            spelling::set_spelling_language,
            import_folder::read_import_images
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitGate>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    #[cfg(target_os = "macos")]
                    drawing::close(app);
                    if let Err(error) = app.emit("request-safe-exit", ()) {
                        eprintln!("Unable to request safe exit: {error}");
                    }
                }
            }
        });
}
