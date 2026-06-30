// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use chrono;
use rusqlite::{params, Connection, Result};
use uuid::Uuid;

type CommandResult<T> = std::result::Result<T, String>;

#[derive(Debug, serde::Serialize)]
struct Document {
    id: String,
    name: String,
    yjs_state: Vec<u8>,
    updated_at: i64,
}

fn db_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn table(conn: &Connection) -> Result<()> {
    conn.execute(
        "create table if not exists documents (
          id TEXT PRIMARY KEY,
          title TEXT,
          yjs_state BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        );",
        (),
    )?;

    Ok(())
}

#[tauri::command]
fn get_doc(yjs_state: Vec<u8>) -> CommandResult<Document> {
    let conn = Connection::open("main.db").map_err(db_err)?;

    table(&conn).map_err(db_err)?;

    let updated_at: i64 = chrono::offset::Utc::now().timestamp();

    conn.execute(
        "insert into documents (id, title, yjs_state, updated_at)
             values (?1, ?2, ?3, ?4)",
        params!["doc2", "Document 2", yjs_state, updated_at],
    )
    .map_err(db_err)?;

    let mut stmt = conn.prepare("select * from documents ").map_err(db_err)?;

    let doc = stmt
        .query_one([], |row| {
            Ok(Document {
                id: row.get(0)?,
                name: row.get(1)?,
                yjs_state: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(db_err)?;

    Ok(doc)
}

#[tauri::command]
fn create_doc(title: String) -> CommandResult<String> {
    let conn = Connection::open("main.db").map_err(db_err)?;

    table(&conn).map_err(db_err)?;

    let updated_at: i64 = chrono::offset::Utc::now().timestamp();

    let id = Uuid::new_v4().to_string();

    conn.execute(
        "insert into documents (id, title, yjs_state, updated_at)
             values (?1, ?2, ?3, ?4)",
        params![id, title, Vec::new(), updated_at],
    )
    .map_err(db_err)?;

    Ok(id)
}

#[tauri::command]
fn update_doc(id: String, title: String, yjs_state: Vec<u8>) -> CommandResult<()> {
    let conn = Connection::open("main.db").map_err(db_err)?;

    table(&conn).map_err(db_err)?;

    let updated_at: i64 = chrono::offset::Utc::now().timestamp();

    conn.execute(
        "update documents set title = ?2, yjs_state = ?3, updated_at = ?4 where id = ?1",
        params![id, title, yjs_state, updated_at],
    )
    .map_err(db_err)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_doc, create_doc, update_doc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
