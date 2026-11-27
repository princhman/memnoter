//! Filesystem reconciliation for the desktop Markdown export.
use crate::{db_err, files::assets, CommandResult, Db};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::Path,
};
use uuid::Uuid;

const MANIFEST: &str = ".memnoter-manifest.json";
pub const FOLDER: &str = "Memnoter Backup";

#[derive(Deserialize)]
pub struct Snapshot {
    notes: BTreeMap<String, String>,
    attachments: BTreeMap<String, String>,
}

pub fn image_types(db: &Db) -> CommandResult<BTreeMap<String, String>> {
    let conn = db.lock()?;
    let mut stmt = conn
        .prepare("select id, file_type from files where file_type like 'image/%'")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

fn regular_file(path: &Path) -> CommandResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() => Ok(true),
        Ok(_) => Err(format!("Expected a regular file at {}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(db_err(error)),
    }
}

pub fn write_if_changed(path: &Path, bytes: &[u8]) -> CommandResult<()> {
    if regular_file(path)? && fs::read(path).map_err(db_err)? == bytes {
        return Ok(());
    }
    let temp = path.with_file_name(format!(".memnoter-{}.partial", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(db_err)
}

fn directory(path: &Path) -> CommandResult<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == io::ErrorKind::AlreadyExists
                && fs::symlink_metadata(path).map_err(db_err)?.is_dir() =>
        {
            Ok(())
        }
        Err(error) => Err(db_err(error)),
    }
}

fn filename(name: &str) -> bool {
    !name.starts_with('.') && !name.contains(['/', '\\', ':', '\0'])
}

fn note_path(name: &str) -> bool {
    filename(name) && name.ends_with(".md")
}

fn attachment_path(name: &str) -> bool {
    let Some((id, extension)) = name.split_once('.') else {
        return false;
    };
    Uuid::parse_str(id).is_ok()
        && !extension.is_empty()
        && extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

pub fn write(data_dir: &Path, selected: &Path, snapshot: Snapshot) -> CommandResult<()> {
    let root = selected.join(FOLDER);
    if selected.canonicalize().map_err(db_err)? != selected
        || selected.starts_with(data_dir.canonicalize().map_err(db_err)?)
    {
        return Err("Choose a folder outside Memnoter's app data".into());
    }
    directory(&root)?;
    let manifest = root.join(MANIFEST);
    let previous: BTreeSet<String> = if regular_file(&manifest)? {
        serde_json::from_slice(&fs::read(&manifest).map_err(db_err)?).map_err(db_err)?
    } else if fs::read_dir(&root).map_err(db_err)?.next().is_none() {
        BTreeSet::new()
    } else {
        return Err("Memnoter Backup already exists and contains files".into());
    };
    let mut current = BTreeSet::new();
    for name in snapshot.notes.keys() {
        if !note_path(name) {
            return Err("Invalid Markdown filename".into());
        }
        current.insert(name.clone());
    }
    for (name, id) in &snapshot.attachments {
        if !attachment_path(name) || name.split_once('.').map(|(stem, _)| stem) != Some(id.as_str())
        {
            return Err("Invalid attachment filename".into());
        }
        if !regular_file(&assets::path(data_dir, id)?)? {
            return Err(format!("Attachment {name} is unavailable"));
        }
        current.insert(format!("attachments/{name}"));
    }
    let attachments = root.join("attachments");
    for path in &previous {
        if !note_path(path)
            && !path
                .strip_prefix("attachments/")
                .is_some_and(attachment_path)
        {
            return Err("Invalid path in Markdown backup manifest".into());
        }
    }
    let has_attachments = previous
        .iter()
        .chain(&current)
        .any(|path| path.starts_with("attachments/"));
    if has_attachments {
        match fs::symlink_metadata(&attachments) {
            Ok(info) if info.is_dir() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => return Err("Expected a directory at attachments".into()),
        }
    }
    for path in &current {
        if regular_file(&root.join(path))? && !previous.contains(path) {
            return Err(format!("Backup would overwrite {path}"));
        }
    }
    // Record ownership before writing so retries can finish an interrupted run.
    let owned: BTreeSet<_> = previous.union(&current).collect();
    write_if_changed(&manifest, &serde_json::to_vec(&owned).map_err(db_err)?)?;
    if has_attachments {
        directory(&attachments)?;
    }
    for (name, id) in snapshot.attachments {
        let bytes = fs::read(assets::path(data_dir, &id)?).map_err(db_err)?;
        write_if_changed(&attachments.join(name), &bytes)?;
    }
    for (name, markdown) in snapshot.notes {
        write_if_changed(&root.join(name), markdown.as_bytes())?;
    }
    for obsolete in previous.difference(&current) {
        let path = root.join(obsolete);
        if regular_file(&path)? {
            fs::remove_file(path).map_err(db_err)?;
        }
    }
    write_if_changed(&manifest, &serde_json::to_vec(&current).map_err(db_err)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_linked_assets_and_reconciles_only_owned_files() {
        let directory = std::env::temp_dir().join(format!("memnoter-markdown-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        struct RemoveOnDrop(std::path::PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }
        let _cleanup = RemoveOnDrop(directory.clone());
        let directory = directory.canonicalize().unwrap();
        let source = directory.join("app");
        let destination = directory.join("export");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("files")).unwrap();
        fs::create_dir(&destination).unwrap();
        let image = "00000000-0000-0000-0000-000000000001";
        let pdf = "00000000-0000-0000-0000-000000000002";
        let png = [137, 80, 78, 71, 13, 10, 26, 10];
        let pdf_bytes = b"%PDF-1.7\n";
        assets::write(&source, image, &png).unwrap();
        assets::write(&source, pdf, pdf_bytes).unwrap();
        let markdown = format!(
            "# Motion\n\n![Diagram](attachments/{image}.png)\n\n- [Lecture](attachments/{pdf}.pdf)\n"
        );
        let snapshot = |title: &str| Snapshot {
            notes: BTreeMap::from([
                (format!("{title}.md"), markdown.clone()),
                ("To delete.md".into(), "Temporary note".into()),
            ]),
            attachments: BTreeMap::from([
                (format!("{image}.png"), image.into()),
                (format!("{pdf}.pdf"), pdf.into()),
            ]),
        };

        write(&source, &destination, snapshot("Physics")).unwrap();
        let root = destination.join(FOLDER);
        let note = root.join("Physics.md");
        let image_path = root.join(format!("attachments/{image}.png"));
        let pdf_path = root.join(format!("attachments/{pdf}.pdf"));
        assert_eq!(fs::read_to_string(&note).unwrap(), markdown);
        assert_eq!(fs::read(&image_path).unwrap(), png);
        assert_eq!(fs::read(&pdf_path).unwrap(), pdf_bytes);
        let old_time =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        for path in [&note, &image_path, &pdf_path] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(old_time)
                .unwrap();
        }
        write(&source, &destination, snapshot("Physics")).unwrap();
        for path in [&note, &image_path, &pdf_path] {
            assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), old_time);
        }

        fs::write(root.join("My own note.md"), "Keep this").unwrap();
        let mut renamed = snapshot("Mechanics");
        renamed.notes.remove("To delete.md");
        write(&source, &destination, renamed).unwrap();
        assert!(!note.exists());
        assert!(!root.join("To delete.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("My own note.md")).unwrap(),
            "Keep this"
        );
        assert_eq!(
            fs::read_to_string(root.join("Mechanics.md")).unwrap(),
            markdown
        );

        let mut paths: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .chain(fs::read_dir(root.join("attachments")).unwrap())
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .strip_prefix(&root)
                    .unwrap()
                    .display()
                    .to_string()
            })
            .collect();
        paths.sort();
        println!("{FOLDER}/\n{}", paths.join("\n"));

        write(
            &source,
            &destination,
            Snapshot {
                notes: BTreeMap::new(),
                attachments: BTreeMap::new(),
            },
        )
        .unwrap();
        assert!(!root.join("Mechanics.md").exists());
        assert!(!image_path.exists());
        assert!(!pdf_path.exists());
    }
}
