use memnoter_core::Core;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CString},
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
};
use tauri::Manager;

#[derive(Default)]
pub struct DrawingGate(Arc<AtomicBool>);
struct Editing(Arc<AtomicBool>);
impl Drop for Editing {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

extern "C" {
    fn memnoter_present_drawing(
        window: *mut c_void,
        path: *const c_char,
        context: u64,
        callback: extern "C" fn(u64, i32),
    );
    fn memnoter_focus_drawing();
    fn memnoter_close_drawing();
    fn memnoter_drawing_history(redo: bool);
}

extern "C" fn drawing_finished(context: u64, status: i32) {
    // Swift calls this exactly once after removing the native canvas, or when
    // presentation fails. Reclaim the sender on either completion path.
    let sender = unsafe { Box::from_raw(context as *mut mpsc::Sender<i32>) };
    let _ = sender.send(status);
}

pub fn close<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if app.state::<DrawingGate>().0.load(Ordering::SeqCst) {
        let _ = app.run_on_main_thread(|| unsafe { memnoter_close_drawing() });
    }
}

pub fn handle_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> bool {
    if !app.state::<DrawingGate>().0.load(Ordering::SeqCst) {
        return false;
    }
    if id == "editor-undo" || id == "editor-redo" {
        let redo = id == "editor-redo";
        let _ = app.run_on_main_thread(move || unsafe { memnoter_drawing_history(redo) });
    }
    // The note must not navigate or mutate underneath the native canvas.
    true
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn draft_path(core: &Core, module: &str, image: &str) -> Result<PathBuf, String> {
    for id in [module, image] {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid drawing identity".to_owned())?;
    }
    Ok(core
        .data_dir()
        .join("drawing-drafts-mac")
        .join(format!("{module}_{image}.json")))
}
fn call(core: &Core, command: &str, args: Value) -> Result<Value, String> {
    let result = memnoter_core::dispatch(core, command, &args.to_string())
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&result).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn edit_drawing(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Core>>,
    gate: tauri::State<'_, DrawingGate>,
    module_id: String,
    image_id: String,
    source_id: Option<String>,
) -> Result<Value, String> {
    if gate.0.swap(true, Ordering::SeqCst) {
        app.run_on_main_thread(|| unsafe { memnoter_focus_drawing() })
            .map_err(|error| error.to_string())?;
        return Ok(json!({"status":"active","asCopy":false,"hasChanges":false}));
    }
    let editing = Editing(gate.0.clone());
    let core = state.inner().clone();
    let native_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _editing = editing;
        let draft = draft_path(&core, &module_id, &image_id)?;
        let modules = call(&core, "modules", json!({}))?;
        if !modules.as_array().unwrap().iter().any(|module| module["id"] == module_id) { return Err("This note was removed. The local drawing draft is retained.".into()); }
        let temporary = Temporary(std::env::temp_dir().join(format!("memnoter-drawing-{}", uuid::Uuid::new_v4())));
        fs::DirBuilder::new().mode(0o700).create(&temporary.0).map_err(|error| error.to_string())?;
        let result_path = temporary.0.join("result.json");
        let request_path = temporary.0.join("request.json");
        let source_path = source_id.as_ref().and_then(|id| call(&core, "resolve_card_image", json!({"fileId":id})).ok());
        let maximum = memnoter_core::sync::session::contract()["MAX_FILE_BYTES"].as_u64().unwrap() - 29;
        fs::write(&request_path, json!({"moduleId":module_id,"imageId":image_id,"sourceId":source_id,"sourcePath":source_path,
            "draftPath":draft,"resultPath":result_path,"maximumBytes":maximum,
            "preferencesScope":core.data_dir().file_name().unwrap_or_default().to_string_lossy()}).to_string()).map_err(|error| error.to_string())?;
        let window = native_app.get_webview_window("main").ok_or("The note window is closed")?;
        let request = CString::new(request_path.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
        let (sender, receiver) = mpsc::channel::<i32>();
        let context = Box::into_raw(Box::new(sender)) as u64;
        if let Err(error) = native_app.run_on_main_thread(move || {
            match window.ns_window() {
                Ok(pointer) => unsafe { memnoter_present_drawing(pointer, request.as_ptr(), context, drawing_finished) },
                Err(_) => drawing_finished(context, 1),
            }
        }) {
            // Dispatch failed, so no native callback can own the context.
            unsafe { drop(Box::from_raw(context as *mut mpsc::Sender<i32>)); }
            return Err(error.to_string());
        }
        match receiver.recv().map_err(|error| error.to_string())? {
            0 => {},
            2 => return Ok(json!({"status":"active","asCopy":false,"hasChanges":false})),
            _ => return Err("Could not open the canvas in this window. Your local draft is retained.".into()),
        }
        let result_bytes = fs::read(&result_path).map_err(|_| "The drawing editor closed without finishing. Reopen the drawing to continue.".to_owned())?;
        let mut result: Value = serde_json::from_slice(&result_bytes).map_err(|error| error.to_string())?;
        if result["status"] == "save" {
            for (field, result_field, mime) in [("sourcePath", "source", "application/vnd.memnoter.drawing+json"), ("previewPath", "preview", "image/png")] {
                let path = Path::new(result[field].as_str().ok_or("Missing drawing output")?);
                if path.parent() != Some(temporary.0.as_path()) { return Err("Invalid drawing output path".into()); }
                let bytes = fs::read(path).map_err(|error| error.to_string())?;
                if bytes.len() as u64 > maximum { return Err("The drawing exceeds the sync file limit. Your local draft is retained.".into()); }
                result[result_field] = call(&core, "save_file", json!({"moduleId":module_id,"bytes":bytes,"mimeType":mime}))?;
            }
        }
        result.as_object_mut().unwrap().remove("sourcePath");
        result.as_object_mut().unwrap().remove("previewPath");
        Ok(result)
    }).await.map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    result
}

#[tauri::command]
pub fn drawing_committed(
    state: tauri::State<'_, Arc<Core>>,
    module_id: String,
    image_id: String,
) -> Result<(), String> {
    match fs::remove_file(draft_path(&state, &module_id, &image_id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
