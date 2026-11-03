use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use uuid::Uuid;
pub mod asset_refs;
pub mod backups;
pub mod cards;
use cards::migrate_flashcards;
pub mod db;
pub use db::Db;
pub(crate) use db::*;
pub type CommandResult<T> = std::result::Result<T, String>;
/// One database connection and its managed data directory.
pub struct Core {
    pub db: Db,
    data_dir: PathBuf,
}
impl Core {
    pub fn open(data_dir: impl AsRef<Path>) -> CommandResult<Self> {
        let data_dir = data_dir.as_ref().to_path_buf();
        let db = initialize_data(&data_dir)?;
        Ok(Self { db, data_dir })
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}
pub mod content;
pub use content::*;
#[derive(Debug, serde::Serialize)]
pub struct Module {
    pub id: String,
    pub name: String,
    pub heading_numbering: bool,
}
#[derive(Debug, serde::Serialize)]
pub struct ContentUpdate {
    pub id: i64,
    pub bytes: Vec<u8>,
}
#[derive(Debug, serde::Serialize)]
pub struct GetContentResponse {
    pub state: Vec<u8>,
    pub updates: Vec<ContentUpdate>,
    pub files: Vec<FileType>,
}

#[derive(Debug, serde::Serialize)]
pub struct FileType {
    pub id: String,
    pub path: String,
    pub file_type: String,
}

pub mod files;
pub use files::*;

pub mod search;
pub use search::*;

#[cfg(test)]
mod tests;
