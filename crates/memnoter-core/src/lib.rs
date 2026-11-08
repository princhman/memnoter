use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use uuid::Uuid;
pub mod asset_refs;
pub mod backups;
pub mod cards;
pub mod sync;
use cards::migrate_flashcards;
pub mod db;
pub use db::Db;
pub(crate) use db::*;
pub type CommandResult<T> = std::result::Result<T, String>;
/// Stable errors at host boundaries; legacy storage functions retain their messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    StaleGeneration,
    Unavailable,
    Conflict,
    NotFound,
    Storage(String),
}
impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::StaleGeneration => "stale_generation",
            Self::Unavailable => "unavailable",
            Self::Conflict => "conflict",
            Self::NotFound => "not_found",
            Self::Storage(_) => "storage",
        }
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::StaleGeneration => "SYNC_STALE_GENERATION",
            Self::Unavailable => "Database unavailable. Restart the app to recover.",
            Self::Conflict => "The card was reviewed elsewhere; reload the review",
            Self::NotFound => "The card no longer exists",
            Self::Storage(message) => message,
        })
    }
}
impl std::error::Error for CoreError {}
impl From<String> for CoreError {
    fn from(message: String) -> Self {
        match message.as_str() {
            "SYNC_STALE_GENERATION" => Self::StaleGeneration,
            value if value.starts_with("Database unavailable.") => Self::Unavailable,
            "The card was reviewed elsewhere; reload the review" => Self::Conflict,
            "The card no longer exists" => Self::NotFound,
            _ => Self::Storage(message),
        }
    }
}
impl From<&str> for CoreError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl serde::Serialize for CoreError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut value = serializer.serialize_struct("CoreError", 2)?;
        value.serialize_field("code", self.code())?;
        value.serialize_field("message", &self.to_string())?;
        value.end()
    }
}

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
    pub fn set_outbox_callback(&self, callback: std::sync::Arc<dyn Fn() + Send + Sync>) {
        *self
            .db
            .outbox_callback
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(callback);
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}
pub mod import;
pub use import::*;
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

mod dispatch;
pub use dispatch::{dispatch, DATA_COMMANDS};
