//! Sidebar metadata is independent of note content and shared host types.
use crate::{db_err, CommandResult, Db};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SidebarItem {
    pub id: String,
    // A name identifies a folder; module names remain owned by modules.
    pub name: Option<String>,
    pub folder_id: Option<String>,
    pub sort_order: i64,
    pub collapsed: bool,
    pub deleted: bool,
}

pub(crate) fn read(conn: &Connection) -> CommandResult<Vec<SidebarItem>> {
    let mut stmt = conn
        .prepare("select data from sidebar_items order by id")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    rows.map(|row| serde_json::from_str(&row.map_err(db_err)?).map_err(db_err))
        .collect()
}

pub(crate) fn store(conn: &Connection, item: &SidebarItem) -> CommandResult<bool> {
    conn.execute(
        "insert into sidebar_items(id, data) values (?1, ?2) on conflict(id) do update set data = excluded.data where data != excluded.data",
        rusqlite::params![item.id, serde_json::to_string(item).map_err(db_err)?],
    ).map(|count| count > 0).map_err(db_err)
}

pub fn sidebar_items(db: &Db) -> CommandResult<Vec<SidebarItem>> {
    let conn = db.lock()?;
    read(&conn)
}

pub fn save_sidebar_items(db: &Db, items: Vec<SidebarItem>) -> CommandResult<()> {
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let mut known = read(&tx)?;
    for item in &items {
        if item.id.is_empty()
            || item
                .name
                .as_ref()
                .is_some_and(|name| name.trim().is_empty())
        {
            return Err("Sidebar item must have an id and a nonempty folder name".into());
        }
        if item.name.is_some() && item.folder_id.is_some() {
            return Err("Folders cannot be nested".into());
        }
        if let Some(previous) = known.iter().find(|entry| entry.id == item.id) {
            if previous.name.is_some() != item.name.is_some() || previous.deleted && !item.deleted {
                return Err("Sidebar item kind and deletion are permanent".into());
            }
        }
        known.retain(|entry| entry.id != item.id);
        known.push(item.clone());
    }
    for item in &items {
        if let Some(parent) = &item.folder_id {
            if !known
                .iter()
                .any(|folder| folder.id == *parent && folder.name.is_some() && !folder.deleted)
            {
                return Err("Folder no longer exists".into());
            }
        }
        store(&tx, item)?;
    }
    crate::sync::record_sidebar(&tx, &items)?;
    tx.commit().map_err(db_err)
}
