use memnoter_core::CommandResult;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
static ROOTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[derive(Serialize)]
pub(crate) struct Entry {
    path: String,
    text: Option<String>,
    bytes: Option<Vec<u8>>,
    #[serde(rename = "sourceId")]
    source_id: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct Folder {
    name: String,
    entries: Vec<Entry>,
}
fn read_folder(root: &Path) -> CommandResult<Folder> {
    fn walk(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> CommandResult<()> {
        for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = item.file_type().map_err(|e| e.to_string())?;
            // Never follow links out of the selected folder or into cycles.
            if kind.is_symlink() {
                continue;
            }
            let path = item.path();
            if kind.is_dir() {
                walk(root, &path, entries)?;
            } else if kind.is_file() {
                let ext = path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                entries.push(Entry {
                    path: path
                        .strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    text: if ext == "md" {
                        Some(std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
                    } else {
                        None
                    },
                    bytes: None,
                    source_id: None,
                });
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(root, root, &mut entries)?;
    Ok(Folder {
        name: root
            .file_name()
            .ok_or("Folder has no name")?
            .to_string_lossy()
            .into(),
        entries,
    })
}

#[tauri::command(async)]
pub(crate) fn pick_import_folder() -> CommandResult<Option<Folder>> {
    // Native picker and filesystem reads run outside the webview's UI thread.
    rfd::FileDialog::new()
        .set_title("Import Obsidian folder")
        .pick_folder()
        .map(|path| {
            let mut folder = read_folder(&path)?;
            let mut roots = ROOTS
                .get_or_init(Default::default)
                .lock()
                .map_err(|e| e.to_string())?;
            let id = format!("picked-{}", roots.len() + 1);
            roots.insert(id.clone(), path.canonicalize().map_err(|e| e.to_string())?);
            for entry in &mut folder.entries {
                entry.source_id = Some(id.clone());
            }
            Ok(folder)
        })
        .transpose()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageRequest {
    source_id: String,
    path: String,
}

#[tauri::command(async)]
pub(crate) fn read_import_images(images: Vec<ImageRequest>) -> CommandResult<Vec<Vec<u8>>> {
    let roots = ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    images
        .into_iter()
        .map(|image| {
            let root = roots.get(&image.source_id).ok_or("Unknown picked folder")?;
            let path = root
                .join(&image.path)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !path.starts_with(root)
                || !["png", "jpg", "jpeg", "webp", "gif"].contains(
                    &path
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                        .as_str(),
                )
            {
                return Err("Image is outside the picked folder or unsupported".into());
            }
            std::fs::read(path).map_err(|e| e.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lazy_image_reads_are_scoped_to_the_selected_root() {
        let dir = std::env::temp_dir().join(format!("memnoter-import-scoped-{}", std::process::id()));
        let root = dir.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("used.png"), [1, 2]).unwrap();
        std::fs::write(dir.join("outside.png"), [3]).unwrap();
        let folder = read_folder(&root).unwrap();
        assert!(folder.entries.iter().all(|entry| entry.bytes.is_none()));
        ROOTS.get_or_init(Default::default).lock().unwrap().insert("test-root".into(), root.canonicalize().unwrap());
        let request = |path: &str| ImageRequest { source_id: "test-root".into(), path: path.into() };
        assert_eq!(read_import_images(vec![request("used.png")]).unwrap(), vec![vec![1, 2]]);
        assert!(read_import_images(vec![request("../outside.png")]).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(dir.join("outside.png"), root.join("escape.png")).unwrap();
            assert!(read_import_images(vec![request("escape.png")]).is_err());
        }
        ROOTS.get().unwrap().lock().unwrap().remove("test-root");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_notes_and_images_without_hidden_files_or_links() {
        let dir = std::env::temp_dir().join(format!("memnoter-import-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        std::fs::write(dir.join("a.md"), "# Note").unwrap();
        std::fs::write(dir.join("a.png"), [1, 2]).unwrap();
        std::fs::write(dir.join("a.pdf"), [3]).unwrap();
        std::fs::write(dir.join(".obsidian/config"), "private").unwrap();
        let folder = read_folder(&dir).unwrap();
        assert_eq!(folder.entries.len(), 3);
        assert_eq!(
            folder
                .entries
                .iter()
                .find(|e| e.path == "a.md")
                .unwrap()
                .text
                .as_deref(),
            Some("# Note")
        );
        assert!(folder
            .entries
            .iter()
            .find(|e| e.path == "a.pdf")
            .unwrap()
            .bytes
            .is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
