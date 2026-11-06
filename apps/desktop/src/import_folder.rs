use memnoter_core::CommandResult;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub(crate) struct Entry {
    path: String,
    text: Option<String>,
    bytes: Option<Vec<u8>>,
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
                    bytes: if ["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) {
                        Some(std::fs::read(&path).map_err(|e| e.to_string())?)
                    } else {
                        None
                    },
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
        .map(|path| read_folder(&path))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
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
