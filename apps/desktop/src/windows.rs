use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

#[derive(Default)]
pub struct Windows {
    pub(crate) creation: Mutex<()>,
    pub(crate) restoring: AtomicBool,
    pub(crate) installing: AtomicBool,
    exit: Mutex<Option<Exit>>,
}

struct Exit {
    restart: bool,
    waiting: Vec<String>,
}

fn request(app: &AppHandle, label: &str, event: &str) -> tauri::Result<()> {
    app.emit_to(EventTarget::webview_window(label), event, ())
}

#[tauri::command]
pub async fn open_window(app: AppHandle, module_id: Option<String>) -> Result<(), String> {
    let windows = app.state::<Windows>();
    let _creation = windows.creation.lock().map_err(|e| e.to_string())?;
    if windows.restoring.load(Ordering::SeqCst)
        || windows.installing.load(Ordering::SeqCst)
        || windows.exit.lock().map_err(|e| e.to_string())?.is_some()
    {
        return Err("Another app operation is in progress.".into());
    }
    if let Some(id) = &module_id {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid module ID")?;
    }
    let mut config = app.config().app.windows[0].clone();
    config.label = format!("note-{}", uuid::Uuid::new_v4());
    config.maximized = false;
    let initial_module = serde_json::to_string(&module_id).map_err(|e| e.to_string())?;
    let window = tauri::WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .initialization_script(format!(
            "window.__memnoterInitialModule = {initial_module};"
        ))
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if let Err(error) = window.with_webview(|webview| {
        crate::selection_limit::limit_attributed_substrings(webview.inner())
    }) {
        eprintln!("Unable to configure selection in the new window: {error}");
    }
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub fn show_main_settings(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("The main window is closed.")?;
    main.show()
        .and_then(|()| main.unminimize())
        .and_then(|()| main.set_focus())
        .and_then(|()| request(&app, "main", "open-main-settings"))
        .map_err(|e| e.to_string())
}

fn advance_exit(app: &AppHandle, exit: &Exit) -> tauri::Result<()> {
    if let Some(label) = exit.waiting.last() {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_focus();
        }
        request(app, label, "request-safe-close")
    } else {
        // A save failure must be actionable even when the main window was hidden.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
        }
        request(
            app,
            "main",
            if exit.restart {
                "request-safe-restart"
            } else {
                "request-safe-exit"
            },
        )
    }
}

pub fn begin_exit(app: &AppHandle, restart: bool) -> tauri::Result<()> {
    let windows = app.state::<Windows>();
    let _creation = windows
        .creation
        .try_lock()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?;
    let mut pending = windows.exit.lock().unwrap();
    if pending.is_none() {
        let exit = Exit {
            restart,
            waiting: app
                .webview_windows()
                .into_keys()
                .filter(|label| label.starts_with("note-"))
                .collect(),
        };
        advance_exit(app, &exit)?;
        *pending = Some(exit);
    } else if let Some(exit) = pending.as_ref() {
        // A window opened just before Quit may have missed the first request.
        advance_exit(app, exit)?;
    }
    Ok(())
}

#[tauri::command]
pub fn request_restart(app: AppHandle) -> Result<(), String> {
    begin_exit(&app, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_window_exit(app: AppHandle) {
    *app.state::<Windows>().exit.lock().unwrap() = None;
}

#[tauri::command]
pub fn confirm_window_close(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let others = app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with("note-") && label != window.label());
    let windows = app.state::<Windows>();
    let mut pending = windows.exit.lock().unwrap();
    if window.label() == "main" {
        if others || pending.is_some() {
            return window.hide().map_err(|e| e.to_string());
        }
        drop(pending);
        return begin_exit(app, false).map_err(|e| e.to_string());
    }
    // Do not finish the app while another window is still being created.
    let creation = windows.creation.try_lock();
    window.destroy().map_err(|e| e.to_string())?;
    if let Some(exit) = pending.as_mut() {
        if exit
            .waiting
            .last()
            .is_some_and(|label| label == window.label())
        {
            exit.waiting.pop();
            return advance_exit(app, exit).map_err(|e| e.to_string());
        }
        exit.waiting.retain(|label| label != window.label());
    } else if creation.is_ok()
        && !others
        && app
            .get_webview_window("main")
            .is_some_and(|main| !main.is_visible().unwrap_or(true))
    {
        *pending = Some(Exit {
            restart: false,
            waiting: Vec::new(),
        });
        // The runtime removes the destroyed window asynchronously. It has
        // already flushed, so ask only the hidden main window to finish.
        advance_exit(app, pending.as_ref().unwrap()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn close_requested(window: &tauri::Window) {
    if window.label() == "main"
        && !window
            .app_handle()
            .webview_windows()
            .keys()
            .any(|label| label.starts_with("note-"))
    {
        if let Err(error) = begin_exit(window.app_handle(), false) {
            eprintln!("Unable to request safe app exit: {error}");
        }
    } else if let Err(error) = request(window.app_handle(), window.label(), "request-safe-close") {
        eprintln!("Unable to request safe window close: {error}");
    }
}

pub fn announce(
    app: &AppHandle,
    sender: &str,
    command: &str,
    args: &serde_json::Value,
    result: &serde_json::Value,
) {
    let module = &args["moduleId"];
    if app.webview_windows().len() < 2 {
        return;
    }
    let event = match command {
        "add_update" => (
            "note-update-saved",
            serde_json::json!({ "moduleId": module, "update": result }),
        ),
        "sync_apply" | "sync_reconcile" => ("desktop-sync-applied", result.clone()),
        "save_file" | "sync_store_file" => (
            "note-file-saved",
            serde_json::json!({ "moduleId": module, "file": result }),
        ),
        "delete_module" => ("desktop-module-deleted", module.clone()),
        "create_module"
        | "import_module"
        | "rename_module"
        | "save_sidebar_items"
        | "set_module_numbering" => ("desktop-library-changed", serde_json::Value::Null),
        "index_note" => ("desktop-search-changed", serde_json::Value::Null),
        "review_card" | "undo_review" | "sync_cards" => {
            ("desktop-cards-changed", serde_json::Value::Null)
        }
        "question_bank_edit"
        | "worksheet_attempt_create"
        | "worksheet_attempt_finish"
        | "worksheet_answer_document_save"
        | "worksheet_answer_save"
        | "worksheet_canvas_save" => ("desktop-worksheet-changed", module.clone()),
        "add_document" | "add_document_bytes" | "rename_document" | "delete_document" => {
            ("desktop-documents-changed", serde_json::Value::Null)
        }
        "save_annotation_update" => ("desktop-annotations-changed", args["documentId"].clone()),
        _ => return,
    };
    if let Err(error) = app.emit_filter(event.0, event.1, |target| match target {
        EventTarget::WebviewWindow { label }
        | EventTarget::Window { label }
        | EventTarget::Webview { label } => label != sender,
        _ => false,
    }) {
        eprintln!("Unable to announce {command} from {sender}: {error}");
    }
}

#[tauri::command]
pub fn primary_window_ready(window: WebviewWindow) {
    if window.label() == "main" {
        window
            .app_handle()
            .state::<Windows>()
            .restoring
            .store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn request_desktop_file(app: AppHandle, file_id: String) -> Result<(), String> {
    app.emit_to(
        EventTarget::webview_window("main"),
        "desktop-file-requested",
        file_id,
    )
    .map_err(|e| e.to_string())
}

pub fn exit_ready(window: &WebviewWindow, restart: bool) -> bool {
    window.label() == "main"
        && window
            .app_handle()
            .state::<Windows>()
            .exit
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|exit| exit.restart == restart && exit.waiting.is_empty())
}

#[tauri::command]
pub fn set_update_installing(window: WebviewWindow, installing: bool) -> Result<(), String> {
    let app = window.app_handle();
    let windows = app.state::<Windows>();
    let _creation = windows
        .creation
        .try_lock()
        .map_err(|_| "A window is opening. Try updating again.")?;
    if window.label() != "main" || (installing && app.webview_windows().len() > 1) {
        return Err("Close other windows before installing the update.".into());
    }
    windows.installing.store(installing, Ordering::SeqCst);
    Ok(())
}
