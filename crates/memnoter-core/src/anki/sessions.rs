use super::{read_package, AnkiArchive, AnkiPackage};
use crate::CommandResult;
use serde::Serialize;
use std::{collections::HashMap, path::Path};

#[derive(Default)]
pub struct Sessions {
    archives: HashMap<String, SessionArchive>,
}
struct SessionArchive {
    archive: AnkiArchive,
    path: std::path::PathBuf,
}
impl Drop for SessionArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPackage {
    pub source_id: String,
    pub file_name: String,
    pub package: AnkiPackage,
}
impl Sessions {
    pub fn open(&mut self, path: &Path) -> CommandResult<OpenedPackage> {
        let source_id = uuid::Uuid::new_v4().to_string();
        let snapshot = std::env::temp_dir().join(format!("memnoter-anki-{source_id}.apkg"));
        std::fs::copy(path, &snapshot).map_err(|e| e.to_string())?;
        let opened = AnkiArchive::open(&snapshot);
        let archive = match opened {
            Ok(archive) => SessionArchive {
                archive,
                path: snapshot,
            },
            Err(error) => {
                let _ = std::fs::remove_file(snapshot);
                return Err(error);
            }
        };
        let package = read_package(&archive.archive)?;
        self.archives.insert(source_id.clone(), archive);
        Ok(OpenedPackage {
            source_id,
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            package,
        })
    }
    pub fn read_media(&self, source_id: &str, names: &[String]) -> CommandResult<Vec<Vec<u8>>> {
        if names.len() > 256 {
            return Err("Too many images requested at once".into());
        }
        let archive = self
            .archives
            .get(source_id)
            .ok_or("This Anki session is closed")?;
        let mut total = 0;
        names
            .iter()
            .map(|name| {
                let bytes = archive.archive.read_media(name)?;
                total += bytes.len();
                if total > 128 * 1024 * 1024 {
                    return Err("Anki image batch exceeds 128 MiB".into());
                }
                Ok(bytes)
            })
            .collect()
    }
    pub fn close(&mut self, source_id: &str) {
        self.archives.remove(source_id);
    }
}
