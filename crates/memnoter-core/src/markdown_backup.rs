//! Filesystem reconciliation for the desktop Markdown export.
use crate::{db_err, files::assets, CommandResult, Db};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    modules: BTreeMap<String, Module>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Module {
    Ready {
        name: String,
        filename: String,
        markdown: String,
        attachments: BTreeMap<String, String>,
    },
    Skipped {
        reason: String,
    },
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct OwnedFile {
    hash: Option<String>,
    modules: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Manifest {
    Hashed(BTreeMap<String, OwnedFile>),
    Legacy(BTreeSet<String>),
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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

fn existing_bytes(path: &Path) -> CommandResult<Option<Vec<u8>>> {
    regular_file(path)?
        .then(|| fs::read(path).map_err(db_err))
        .transpose()
}

fn load_manifest(root: &Path) -> CommandResult<BTreeMap<String, OwnedFile>> {
    let Some(bytes) = existing_bytes(&root.join(MANIFEST))? else {
        if fs::read_dir(root).map_err(db_err)?.next().is_some() {
            return Err("Memnoter Backup already exists and contains files".into());
        }
        return Ok(BTreeMap::new());
    };
    let previous = match serde_json::from_slice(&bytes).map_err(db_err)? {
        Manifest::Hashed(files) => files,
        Manifest::Legacy(paths) => paths
            .into_iter()
            .map(|path| (path, OwnedFile::default()))
            .collect(),
    };
    for path in previous.keys() {
        if !note_path(path)
            && !path
                .strip_prefix("attachments/")
                .is_some_and(attachment_path)
        {
            return Err("Invalid path in Markdown backup manifest".into());
        }
    }
    Ok(previous)
}

fn save_manifest(root: &Path, files: &BTreeMap<String, OwnedFile>) -> CommandResult<()> {
    write_if_changed(
        &root.join(MANIFEST),
        &serde_json::to_vec(files).map_err(db_err)?,
    )
}

fn preserve_module(
    root: &Path,
    id: &str,
    previous: &BTreeMap<String, OwnedFile>,
    current: &mut BTreeMap<String, OwnedFile>,
) {
    let suffix = format!(" - {id}.md");
    let legacy_notes: Vec<_> = previous
        .iter()
        .filter(|(path, file)| file.hash.is_none() && path.ends_with(&suffix))
        .filter_map(|(path, _)| existing_bytes(&root.join(path)).ok().flatten())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect();
    for (path, file) in previous {
        let legacy_owned = file.hash.is_none()
            && (path.ends_with(&suffix)
                || path.starts_with("attachments/")
                    && legacy_notes
                        .iter()
                        .any(|note| note.contains(&format!("]({path})"))));
        if file.modules.contains(id) || legacy_owned {
            current
                .entry(path.clone())
                .or_insert_with(|| OwnedFile {
                    hash: file.hash.clone(),
                    modules: BTreeSet::new(),
                })
                .modules
                .insert(id.into());
        }
    }
}

fn read_module_files(
    data_dir: &Path,
    filename: String,
    markdown: String,
    attachments: BTreeMap<String, String>,
) -> CommandResult<Vec<(String, Vec<u8>)>> {
    if !note_path(&filename) {
        return Err("Invalid Markdown filename".into());
    }
    let mut files = Vec::new();
    for (name, id) in attachments {
        if !attachment_path(&name)
            || name.split_once('.').map(|(stem, _)| stem) != Some(id.as_str())
        {
            return Err("Invalid attachment filename".into());
        }
        let bytes = existing_bytes(&assets::path(data_dir, &id)?)
            .map_err(|error| format!("Attachment {name} is unavailable ({error})"))?
            .ok_or_else(|| format!("Attachment {name} is unavailable"))?;
        files.push((format!("attachments/{name}"), bytes));
    }
    files.push((filename, markdown.into_bytes()));
    Ok(files)
}

pub fn write(data_dir: &Path, selected: &Path, snapshot: Snapshot) -> CommandResult<Vec<String>> {
    let root = selected.join(FOLDER);
    if selected.canonicalize().map_err(db_err)? != selected
        || selected.starts_with(data_dir.canonicalize().map_err(db_err)?)
    {
        return Err("Choose a folder outside Memnoter's app data".into());
    }
    directory(&root)?;
    let mut previous = load_manifest(&root)?;
    let attachments = root.join("attachments");
    if previous.keys().any(|path| path.starts_with("attachments/")) {
        match fs::symlink_metadata(&attachments) {
            Ok(info) if info.is_dir() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => return Err("Expected a directory at attachments".into()),
        }
    }
    if !regular_file(&root.join(MANIFEST))? {
        save_manifest(&root, &previous)?;
    }

    let mut current = BTreeMap::<String, OwnedFile>::new();
    let mut conflicts = BTreeSet::new();
    let mut warnings = Vec::new();
    for (id, module) in snapshot.modules {
        let (name, filename, markdown, module_attachments) = match module {
            Module::Ready {
                name,
                filename,
                markdown,
                attachments,
            } => (name, filename, markdown, attachments),
            Module::Skipped { reason } => {
                preserve_module(&root, &id, &previous, &mut current);
                warnings.push(reason);
                continue;
            }
        };
        let result = (|| -> CommandResult<()> {
            let files = read_module_files(data_dir, filename, markdown, module_attachments)?;
            if files.len() > 1 {
                directory(&attachments)?;
            }
            // Check every destination before changing a module's export.
            for (path, bytes) in &files {
                let Some(existing) = existing_bytes(&root.join(path))? else {
                    continue;
                };
                let owned = current.get(path).or_else(|| previous.get(path));
                let matches = owned.is_some_and(|file| match &file.hash {
                    Some(hash) => *hash == content_hash(&existing),
                    None => existing == *bytes,
                });
                if !matches {
                    conflicts.insert(path.clone());
                    return Err(format!("Backup would overwrite {path}"));
                }
            }
            for (path, bytes) in files {
                write_if_changed(&root.join(&path), &bytes)?;
                let file = current.entry(path).or_default();
                file.hash = Some(content_hash(&bytes));
                file.modules.insert(id.clone());
            }
            Ok(())
        })();
        if let Err(error) = result {
            preserve_module(&root, &id, &previous, &mut current);
            warnings.push(format!("Skipped backup of “{name}”: {error}"));
        }
    }

    for path in conflicts {
        current.remove(&path);
        previous.remove(&path);
    }
    for (path, file) in previous {
        if current.contains_key(&path) {
            continue;
        }
        let Some(hash) = file.hash else { continue };
        let target = root.join(path);
        match fs::symlink_metadata(&target) {
            Ok(info) if info.is_file() => {
                if content_hash(&fs::read(&target).map_err(db_err)?) == hash {
                    fs::remove_file(target).map_err(db_err)?;
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(db_err(error)),
        }
    }
    save_manifest(&root, &current)?;
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_modules<const N: usize>(modules: [(&str, Module); N]) -> Snapshot {
        Snapshot {
            modules: modules
                .into_iter()
                .map(|(id, module)| (id.into(), module))
                .collect(),
        }
    }

    fn ready(name: &str, markdown: &str, attachments: BTreeMap<String, String>) -> Module {
        Module::Ready {
            name: name.into(),
            filename: format!("{name}.md"),
            markdown: markdown.into(),
            attachments,
        }
    }

    struct Backup {
        base: std::path::PathBuf,
        source: std::path::PathBuf,
        destination: std::path::PathBuf,
        root: std::path::PathBuf,
    }

    impl Backup {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("memnoter-markdown-{}", Uuid::new_v4()));
            fs::create_dir(&base).unwrap();
            let base = base.canonicalize().unwrap();
            let source = base.join("app");
            let destination = base.join("export");
            let root = destination.join(FOLDER);
            fs::create_dir(&source).unwrap();
            fs::create_dir(source.join("files")).unwrap();
            fs::create_dir(&destination).unwrap();
            Self {
                base,
                source,
                destination,
                root,
            }
        }

        fn run(&self, snapshot: Snapshot) -> Vec<String> {
            write(&self.source, &self.destination, snapshot).unwrap()
        }
    }

    impl Drop for Backup {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }

    #[test]
    fn writes_linked_assets_and_reconciles_only_owned_files() {
        let backup = Backup::new();
        let Backup {
            source,
            destination,
            root,
            ..
        } = &backup;
        let image = "00000000-0000-0000-0000-000000000001";
        let pdf = "00000000-0000-0000-0000-000000000002";
        let png = [137, 80, 78, 71, 13, 10, 26, 10];
        let pdf_bytes = b"%PDF-1.7\n";
        assets::write(source, image, &png).unwrap();
        assets::write(source, pdf, pdf_bytes).unwrap();
        let markdown = format!(
            "# Motion\n\n![Diagram](attachments/{image}.png)\n\n- [Lecture](attachments/{pdf}.pdf)\n"
        );
        let snapshot = |title: &str| {
            with_modules([
                (
                    "main",
                    ready(
                        title,
                        &markdown,
                        BTreeMap::from([
                            (format!("{image}.png"), image.into()),
                            (format!("{pdf}.pdf"), pdf.into()),
                        ]),
                    ),
                ),
                (
                    "temporary",
                    ready("To delete", "Temporary note", BTreeMap::new()),
                ),
            ])
        };

        write(source, destination, snapshot("Physics")).unwrap();
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
        write(source, destination, snapshot("Physics")).unwrap();
        for path in [&note, &image_path, &pdf_path] {
            assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), old_time);
        }

        fs::write(root.join("My own note.md"), "Keep this").unwrap();
        let mut renamed = snapshot("Mechanics");
        renamed.modules.remove("temporary");
        write(source, destination, renamed).unwrap();
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

        write(source, destination, with_modules([])).unwrap();
        assert!(!root.join("Mechanics.md").exists());
        assert!(!image_path.exists());
        assert!(!pdf_path.exists());
    }

    #[test]
    fn leaves_user_files_after_backup_retry_rename_and_deletion() {
        let backup = Backup::new();
        let snapshot = |title| {
            with_modules([
                ("rename", ready(title, "From Memnoter", BTreeMap::new())),
                ("delete", ready("Delete", "Original", BTreeMap::new())),
            ])
        };
        assert!(backup.run(snapshot("Original")).is_empty());
        let original = backup.root.join("Original.md");
        let deleted = backup.root.join("Delete.md");
        fs::write(&original, "Obsidian edit").unwrap();
        let warnings = backup.run(snapshot("Original"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Original"));
        assert_eq!(fs::read_to_string(&original).unwrap(), "Obsidian edit");

        // Even restoring the exported bytes does not restore relinquished ownership.
        fs::write(&original, "From Memnoter").unwrap();
        let mut renamed = snapshot("Renamed");
        fs::write(&deleted, "User replacement").unwrap();
        renamed.modules.remove("delete");
        assert!(backup.run(renamed).is_empty());
        assert_eq!(fs::read_to_string(&original).unwrap(), "From Memnoter");
        assert_eq!(fs::read_to_string(&deleted).unwrap(), "User replacement");
        assert_eq!(
            fs::read_to_string(backup.root.join("Renamed.md")).unwrap(),
            "From Memnoter"
        );
    }

    #[test]
    fn upgrades_only_matching_legacy_files() {
        let backup = Backup::new();
        fs::create_dir(&backup.root).unwrap();
        fs::write(
            backup.root.join(MANIFEST),
            br#"["Matching.md","Edited.md","Obsolete.md"]"#,
        )
        .unwrap();
        fs::write(backup.root.join("Matching.md"), "Old").unwrap();
        fs::write(backup.root.join("Edited.md"), "My edit").unwrap();
        fs::write(backup.root.join("Obsolete.md"), "Keep me").unwrap();
        let snapshot = |body| {
            with_modules([
                ("matching", ready("Matching", body, BTreeMap::new())),
                ("edited", ready("Edited", "Old", BTreeMap::new())),
            ])
        };
        assert_eq!(backup.run(snapshot("Old")).len(), 1);
        assert_eq!(backup.run(snapshot("New")).len(), 1);
        assert_eq!(
            fs::read_to_string(backup.root.join("Matching.md")).unwrap(),
            "New"
        );
        assert_eq!(
            fs::read_to_string(backup.root.join("Edited.md")).unwrap(),
            "My edit"
        );
        assert_eq!(
            fs::read_to_string(backup.root.join("Obsolete.md")).unwrap(),
            "Keep me"
        );
    }

    #[test]
    fn unavailable_asset_preserves_previous_module_while_other_modules_reconcile() {
        let backup = Backup::new();
        let image = "00000000-0000-0000-0000-000000000001";
        let image_name = format!("{image}.png");
        let asset = assets::write(&backup.source, image, b"original image").unwrap();
        let affected = |title, body| {
            ready(
                title,
                body,
                BTreeMap::from([(image_name.clone(), image.into())]),
            )
        };
        assert!(backup
            .run(with_modules([
                ("affected", affected("Affected", "Original note")),
                ("healthy", ready("Healthy", "Before", BTreeMap::new())),
                ("deleted", ready("Deleted", "Obsolete", BTreeMap::new())),
            ]))
            .is_empty());
        fs::remove_file(asset).unwrap();
        let warnings = backup.run(with_modules([
            ("affected", affected("Renamed", "New note")),
            ("healthy", ready("Healthy", "After", BTreeMap::new())),
        ]));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Renamed") && warnings[0].contains("unavailable"));
        assert_eq!(
            fs::read_to_string(backup.root.join("Affected.md")).unwrap(),
            "Original note"
        );
        assert_eq!(
            fs::read(backup.root.join("attachments").join(&image_name)).unwrap(),
            b"original image"
        );
        assert_eq!(
            fs::read_to_string(backup.root.join("Healthy.md")).unwrap(),
            "After"
        );
        assert!(!backup.root.join("Renamed.md").exists());
        assert!(!backup.root.join("Deleted.md").exists());

        let reason = "An image in “Renamed” is unavailable.";
        assert_eq!(
            backup.run(with_modules([(
                "affected",
                Module::Skipped {
                    reason: reason.into()
                }
            )])),
            [reason]
        );
        assert!(backup.root.join("Affected.md").exists());
        assert!(backup.root.join("attachments").join(&image_name).exists());
        assert!(!backup.root.join("Healthy.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_write_does_not_claim_an_unwritten_attachment() {
        use std::os::unix::fs::PermissionsExt;
        let backup = Backup::new();
        assert!(backup.run(with_modules([])).is_empty());
        let image = "00000000-0000-0000-0000-000000000001";
        let image_name = format!("{image}.png");
        assets::write(&backup.source, image, b"exported image").unwrap();
        let attachments = backup.root.join("attachments");
        fs::create_dir(&attachments).unwrap();
        fs::set_permissions(&attachments, fs::Permissions::from_mode(0o555)).unwrap();
        let probe = attachments.join("permission-probe");
        if fs::write(&probe, b"").is_ok() {
            // A privileged account bypasses the read-only directory.
            return;
        }

        let snapshot = || {
            with_modules([(
                "note",
                ready(
                    "Note",
                    "Body",
                    BTreeMap::from([(image_name.clone(), image.into())]),
                ),
            )])
        };
        let warnings = backup.run(snapshot());
        fs::set_permissions(&attachments, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(!backup.root.join("Note.md").exists());
        let target = attachments.join(image_name.as_str());
        fs::write(&target, b"user image").unwrap();
        assert_eq!(backup.run(snapshot()).len(), 1);
        assert_eq!(fs::read(target).unwrap(), b"user image");
        assert!(!backup.root.join("Note.md").exists());
    }
}
