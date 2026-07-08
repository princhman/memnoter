// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use chrono;
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

fn db_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn init_db(app: &tauri::App) -> CommandResult<Db> {
    let app_dir = app.path().app_data_dir().map_err(db_err)?;

    std::fs::create_dir_all(&app_dir).map_err(db_err)?;

    let db_path = app_dir.join("main.db");
    let conn = Connection::open(&db_path).map_err(db_err)?;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let db = init_db(app).expect("Failed to init db.");
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![create_module, modules])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
