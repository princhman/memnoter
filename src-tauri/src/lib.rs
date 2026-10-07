// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use chrono::Utc;
use rusqlite::{params, Connection, Result};
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

type CommandResult<T> = std::result::Result<T, String>;

struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, serde::Serialize)]
struct Module {
    id: String,
    name: String,
}

#[derive(Debug, serde::Serialize)]
struct ContentUpdate {
    id: i64,
    bytes: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
struct FileType {
    id: String,
    path: String,
    file_type: String,
}

#[derive(Debug, serde::Serialize)]
struct GetContentResponse {
    state: Vec<u8>,
    updates: Vec<ContentUpdate>,
    files: Vec<FileType>,
}

fn db_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn init_db(app: &tauri::App) -> CommandResult<Db> {
    let app_dir = app.path().app_data_dir().map_err(db_err)?;

    std::fs::create_dir_all(&app_dir).map_err(db_err)?;

    let db_path = app_dir.join("main.db");
    let conn = Connection::open(&db_path).map_err(db_err)?;

    let files_path = app_dir.join("files");
    std::fs::create_dir_all(&files_path).map_err(db_err)?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        create table if not exists modules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        create table if not exists contents (
            module_id TEXT PRIMARY KEY,
            state BLOB NOT NULL,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        create table if not exists contents_updates (
            id INTEGER PRIMARY KEY,
            module_id TEXT NOT NULL,
            bytes BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        create table if not exists files (
            id TEXT PRIMARY KEY,
            module_id TEXT NOT NULL,
            path TEXT NOT NULL,
            file_type TEXT NOT NULL
        )",
    )
    .map_err(db_err)?;

    Ok(Db {
        conn: Mutex::new(conn),
    })
}

#[tauri::command]
fn create_module(db: tauri::State<Db>, name: String) -> CommandResult<String> {
    let conn = db.conn.lock().map_err(db_err)?;
    let id = Uuid::new_v4().to_string();

    conn.execute(
        "insert into modules (id, name)
             values (?1, ?2)",
        params![id, name],
    )
    .map_err(db_err)?;

    conn.execute(
        "insert into contents (module_id, state)
             values (?1, ?2)",
        params![id, Vec::<u8>::new()],
    )
    .map_err(db_err)?;

    Ok(id)
}

#[tauri::command]
fn modules(db: tauri::State<Db>) -> CommandResult<Vec<Module>> {
    let conn = db.conn.lock().map_err(db_err)?;
    let mut stmt = conn.prepare("select * from modules").map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Module {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(db_err)?;

    let modules = rows.collect::<Result<Vec<Module>>>().map_err(db_err)?;

    Ok(modules)
}

#[tauri::command]
fn rename_module(db: tauri::State<Db>, module_id: String, name: String) -> CommandResult<()> {
    let conn = db.conn.lock().map_err(db_err)?;

    conn.execute(
        "update modules set name = ?2 where id = ?1",
        params![&module_id, &name],
    )
    .map_err(db_err)?;

    Ok(())
}

#[tauri::command]
fn get_content(db: tauri::State<Db>, module_id: String) -> CommandResult<GetContentResponse> {
    let conn = db.conn.lock().map_err(db_err)?;

    let state = conn
        .query_one(
            "select state from contents where module_id = ?1",
            params![&module_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(db_err)?;

    let mut stmt = conn
        .prepare("select id, bytes from contents_updates where module_id = ?1 order by id asc")
        .map_err(db_err)?;

    let updates = stmt
        .query_map(params![&module_id], |row| {
            Ok(ContentUpdate {
                id: row.get(0)?,
                bytes: row.get(1)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<ContentUpdate>>>()
        .map_err(db_err)?;

    let mut files_stmt = conn
        .prepare("select id, path, file_type from files where module_id = ?1")
        .map_err(db_err)?;

    let files = files_stmt
        .query_map(params![&module_id], |row| {
            Ok(FileType {
                id: row.get(0)?,
                path: row.get(1)?,
                file_type: row.get(2)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<FileType>>>()
        .map_err(db_err)?;

    Ok(GetContentResponse {
        state,
        updates,
        files,
    })
}

// Editing emits a save for every Yjs update. Keep the database lock and disk
// write off the native UI thread so rapid input can continue while it saves.
#[tauri::command(async)]
fn add_update(
    db: tauri::State<Db>,
    module_id: String,
    bytes: Vec<u8>,
) -> CommandResult<ContentUpdate> {
    let conn = db.conn.lock().map_err(db_err)?;

    conn.execute(
        "insert into contents_updates (module_id, bytes, created_at) values (?1, ?2, ?3)",
        params![module_id, bytes, Utc::now().timestamp_millis()],
    )
    .map_err(db_err)?;

    Ok(ContentUpdate {
        id: conn.last_insert_rowid(),
        bytes,
    })
}

#[tauri::command(async)]
fn save_compaction(
    db: tauri::State<Db>,
    module_id: String,
    new_state: Vec<u8>,
    update_id: i64,
) -> CommandResult<()> {
    let conn = db.conn.lock().map_err(db_err)?;

    conn.execute(
        "update contents set state = ?1 where module_id = ?2",
        params![new_state, module_id],
    )
    .map_err(db_err)?;

    conn.execute(
        "delete from contents_updates where module_id = ?1 and id <= ?2",
        params![module_id, update_id],
    )
    .map_err(db_err)?;

    Ok(())
}

#[tauri::command(async)]
fn save_file(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    module_id: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> CommandResult<FileType> {
    let id = Uuid::new_v4().to_string();
    let app_dir = app.path().app_data_dir().map_err(db_err)?;
    let path = app_dir.join("files").join(&id);

    let path_str = path
        .to_str()
        .ok_or_else(|| "File path is not valid UTF-8".to_string())?;

    std::fs::write(&path, &bytes).map_err(db_err)?;

    let conn = db.conn.lock().map_err(db_err)?;

    // ai-suggested error handling - cleanup if failed
    if let Err(error) = conn.execute(
        "insert into files (id, module_id, path, file_type)
         values (?1, ?2, ?3, ?4)",
        params![id, module_id, path_str, mime_type],
    ) {
        if let Err(cleanup_error) = std::fs::remove_file(&path) {
            return Err(format!(
                "Database insert failed: {error}. \
                 File cleanup also failed: {cleanup_error}"
            ));
        }

        return Err(db_err(error));
    }

    Ok(FileType {
        id: id,
        path: path_str.to_owned(),
        file_type: mime_type,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = init_db(app).expect("Failed to init db.");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_module,
            modules,
            get_content,
            add_update,
            rename_module,
            save_compaction,
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
