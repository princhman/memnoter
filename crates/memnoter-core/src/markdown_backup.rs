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
        sections: Option<Vec<Section>>,
        attachments: BTreeMap<String, String>,
    },
    Skipped {
        reason: String,
    },
}

#[derive(Deserialize)]
struct Section {
    filename: String,
    markdown: String,
    section: Option<usize>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct OwnedFile {
    hash: Option<String>,
    modules: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    external: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    section: Option<usize>,
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

pub fn markdown_hash(markdown: &str) -> String {
    content_hash(markdown.as_bytes())
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
    write_unless_changed_since(path, bytes, None)
}

// `seen` is the destination's hash when it was checked (Some(None): absent).
// It is checked again just before the rename, so a save made in another app
// while the export was being staged is kept rather than replaced.
fn write_unless_changed_since(path: &Path, bytes: &[u8], seen: Option<Option<&str>>) -> CommandResult<()> {
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
        if let Some(seen) = seen {
            let now = match fs::read(path) {
                Ok(current) => Some(content_hash(&current)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            if now.as_deref() != seen {
                return Err(io::Error::other(format!("{} changed during the backup", path.display())));
            }
        }
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
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':', '\0'])
}

fn note_path(name: &str) -> bool {
    filename(name) && name.ends_with(".md")
}

fn split_note_path(path: &str) -> Option<&str> {
    let (folder, file) = path.split_once('/')?;
    (filename(folder) && !folder.eq_ignore_ascii_case("attachments") && note_path(file))
        .then_some(folder)
}

fn markdown_path(path: &str) -> bool {
    note_path(path) || split_note_path(path).is_some()
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
        if !markdown_path(path)
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
                    modules: BTreeSet::new(),
                    ..file.clone()
                })
                .modules
                .insert(id.into());
        }
    }
}

type ExportFile = (String, Vec<u8>, Option<usize>);

fn read_module_files(
    data_dir: &Path,
    filename: String,
    markdown: String,
    sections: Option<Vec<Section>>,
    attachments: BTreeMap<String, String>,
) -> CommandResult<Vec<ExportFile>> {
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
        files.push((format!("attachments/{name}"), bytes, None));
    }
    if let Some(sections) = sections {
        let folder = filename.strip_suffix(".md").unwrap();
        let mut claimed = BTreeSet::new();
        for section in sections {
            let path = format!("{folder}/{}", section.filename);
            if split_note_path(&path).is_none() || !claimed.insert(path.to_lowercase()) {
                return Err("Invalid Markdown section filename".into());
            }
            files.push((path, section.markdown.into_bytes(), section.section));
        }
    } else {
        files.push((filename, markdown.into_bytes(), None));
    }
    Ok(files)
}

fn note_filenames(
    modules: &BTreeMap<String, Module>,
    previous: &BTreeMap<String, OwnedFile>,
) -> BTreeMap<String, String> {
    let mut claimed = BTreeSet::new();
    let mut filenames = BTreeMap::new();
    let filenames_by_path: Vec<_> = previous
        .iter()
        .filter_map(|(path, file)| {
            if note_path(path) {
                Some((path.clone(), file))
            } else {
                split_note_path(path).map(|folder| (format!("{folder}.md"), file))
            }
        })
        .collect();
    for (path, file) in &filenames_by_path {
        for id in &file.modules {
            let key = path.to_lowercase();
            match modules.get(id) {
                Some(Module::Ready { filename, .. }) if note_path(filename) => {
                    let stem = filename.strip_suffix(".md").unwrap().to_lowercase();
                    let suffix = format!("{stem} - {}-", &content_hash(id.as_bytes())[..8]);
                    if (key == filename.to_lowercase() || key.starts_with(&suffix))
                        && !filenames.contains_key(id)
                        && claimed.insert(key)
                    {
                        filenames.insert(id.clone(), path.clone());
                    }
                }
                _ => {}
            }
        }
    }

    // A module with an unavailable attachment can still need its old export.
    claimed.extend(
        filenames_by_path
            .iter()
            .filter(|(_, file)| file.modules.iter().any(|id| modules.contains_key(id)))
            .map(|(path, _)| path.to_lowercase()),
    );
    for (id, module) in modules {
        if let Module::Ready { filename, .. } = module {
            if filenames.contains_key(id) || !note_path(filename) {
                continue;
            }
            let mut path = filename.clone();
            let stem = filename.strip_suffix(".md").unwrap();
            let hash = content_hash(id.as_bytes());
            for number in 1.. {
                if claimed.insert(path.to_lowercase()) {
                    break;
                }
                path = format!("{stem} - {}-{number}.md", &hash[..8]);
            }
            filenames.insert(id.clone(), path);
        }
    }
    filenames
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedFile {
    path: String,
    module_id: Option<String>,
    note_name: Option<String>,
    markdown: Option<String>,
    hash: String,
    section: Option<usize>,
    baseline_hash: Option<String>,
}

pub fn edited_files(data_dir: &Path, selected: &Path) -> CommandResult<Vec<EditedFile>> {
    let root = backup_root(data_dir, selected)?;
    match fs::symlink_metadata(&root) {
        Ok(info) if info.is_dir() => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        _ => return Err("Expected a directory at Memnoter Backup".into()),
    }
    let manifest = load_manifest(&root)?;
    check_subfolders(&root, &manifest)?;

    let mut edits = Vec::new();
    for (path, file) in manifest {
        if file.hash.is_none() && !file.external {
            continue;
        }
        let target = root.join(&path);
        if !regular_file(&target)? {
            continue;
        }
        let is_note = markdown_path(&path);
        let (hash, markdown) = if is_note {
            let bytes = fs::read(&target).map_err(db_err)?;
            (content_hash(&bytes), String::from_utf8(bytes).ok())
        } else {
            let mut hasher = Sha256::new();
            io::copy(&mut fs::File::open(&target).map_err(db_err)?, &mut hasher).map_err(db_err)?;
            (format!("{:x}", hasher.finalize()), None)
        };
        if !file.external && file.hash.as_ref() == Some(&hash) {
            continue;
        }
        let module_id = if is_note && file.modules.len() == 1 {
            file.modules.into_iter().next()
        } else {
            None
        };
        edits.push(EditedFile {
            path,
            module_id,
            note_name: file.note_name,
            markdown,
            hash,
            section: file.section,
            baseline_hash: file.hash,
        });
    }
    Ok(edits)
}

fn backup_root(data_dir: &Path, selected: &Path) -> CommandResult<std::path::PathBuf> {
    if selected.canonicalize().map_err(db_err)? != selected
        || selected.starts_with(data_dir.canonicalize().map_err(db_err)?)
    {
        return Err("Choose a folder outside Memnoter's app data".into());
    }
    Ok(selected.join(FOLDER))
}

fn check_subfolders(root: &Path, manifest: &BTreeMap<String, OwnedFile>) -> CommandResult<()> {
    let folders: BTreeSet<_> = manifest
        .keys()
        .filter_map(|path| path.split_once('/').map(|(folder, _)| folder))
        .collect();
    for folder in folders {
        match fs::symlink_metadata(root.join(folder)) {
            Ok(info) if info.is_dir() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => return Err(format!("Expected a directory at {folder}")),
        }
    }
    Ok(())
}

pub fn write(data_dir: &Path, selected: &Path, snapshot: Snapshot) -> CommandResult<Vec<String>> {
    let root = backup_root(data_dir, selected)?;
    directory(&root)?;
    let previous = load_manifest(&root)?;
    check_subfolders(&root, &previous)?;
    if !regular_file(&root.join(MANIFEST))? {
        save_manifest(&root, &previous)?;
    }

    reconcile(data_dir, &root, snapshot, previous)
}

fn reconcile(
    data_dir: &Path,
    root: &Path,
    snapshot: Snapshot,
    previous: BTreeMap<String, OwnedFile>,
) -> CommandResult<Vec<String>> {
    let mut filenames = note_filenames(&snapshot.modules, &previous);
    let previous_by_path: BTreeMap<_, _> = previous
        .iter()
        .map(|(path, file)| (path.to_lowercase(), file))
        .collect();
    let mut current = BTreeMap::<String, OwnedFile>::new();
    let mut conflicts = BTreeSet::new();
    let mut warnings = Vec::new();
    for (id, module) in snapshot.modules {
        let (name, filename, markdown, sections, module_attachments) = match module {
            Module::Ready {
                name,
                filename,
                markdown,
                sections,
                attachments,
            } => (name, filename, markdown, sections, attachments),
            Module::Skipped { reason } => {
                preserve_module(root, &id, &previous, &mut current);
                warnings.push(reason);
                continue;
            }
        };
        let result = (|| -> CommandResult<()> {
            let filename = filenames.remove(&id).unwrap_or(filename);
            let files =
                read_module_files(data_dir, filename, markdown, sections, module_attachments)?;
            let folders: BTreeSet<_> = files
                .iter()
                .filter_map(|(path, _, _)| path.split_once('/').map(|(folder, _)| folder))
                .collect();
            for folder in folders {
                directory(&root.join(folder))?;
            }
            // Check every destination before changing a module's export.
            let mut seen = BTreeMap::new();
            let mut blocked = None;
            for (path, bytes, section) in &files {
                let Some(existing) = existing_bytes(&root.join(path))? else {
                    seen.insert(path.clone(), None);
                    continue;
                };
                seen.insert(path.clone(), Some(content_hash(&existing)));
                if existing == *bytes {
                    // A matching note can be adopted even if a separate
                    // attachment changed and still blocks writes.
                    let file = current.entry(path.clone()).or_default();
                    file.hash = Some(content_hash(bytes));
                    file.external = false;
                    file.modules.insert(id.clone());
                    if markdown_path(path) {
                        file.note_name = Some(name.clone());
                        file.section = *section;
                    }
                    continue;
                }
                let key = path.to_lowercase();
                let owned = current
                    .get(path)
                    .or_else(|| previous.get(path))
                    .or_else(|| previous_by_path.get(&key).copied());
                let matches = owned
                    .filter(|file| !file.external)
                    .and_then(|file| file.hash.as_ref())
                    .is_some_and(|hash| *hash == content_hash(&existing));
                if !matches {
                    conflicts.insert(key);
                    blocked.get_or_insert(path);
                }
            }
            if let Some(path) = blocked {
                return Err(format!("Backup would overwrite {path}"));
            }
            for (path, bytes, section) in files {
                let checked = seen.get(&path).map(|hash: &Option<String>| hash.as_deref());
                write_unless_changed_since(&root.join(&path), &bytes, checked)?;
                let file = current.entry(path.clone()).or_default();
                file.hash = Some(content_hash(&bytes));
                file.external = false;
                if markdown_path(&path) {
                    file.note_name = Some(name.clone());
                    file.section = section;
                }
                file.modules.insert(id.clone());
            }
            Ok(())
        })();
        if let Err(error) = result {
            preserve_module(root, &id, &previous, &mut current);
            warnings.push(format!("Skipped backup of “{name}”: {error}"));
        }
    }

    let current_paths: BTreeSet<_> = current.keys().map(|path| path.to_lowercase()).collect();
    let mut obsolete = Vec::new();
    for (path, mut file) in previous {
        let key = path.to_lowercase();
        if conflicts.contains(&key) {
            file.external = true;
            current.insert(path, file);
            continue;
        }
        if current_paths.contains(&key) {
            continue;
        }
        if file.hash.is_none() && !file.external {
            continue;
        }
        let target = root.join(&path);
        match fs::symlink_metadata(&target) {
            Ok(info) if info.is_file() => {
                let current_hash = content_hash(&fs::read(&target).map_err(db_err)?);
                if !file.external && file.hash.as_ref() == Some(&current_hash) {
                    obsolete.push((path.clone(), current_hash));
                    current.insert(path, file);
                } else {
                    file.external = true;
                    current.insert(path, file);
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(db_err(error)),
        }
    }
    save_manifest(root, &current)?;
    if obsolete.is_empty() {
        return Ok(warnings);
    }
    let mut retained_note_owners: BTreeSet<_> = current
        .iter()
        .filter(|(path, file)| markdown_path(path) && file.external)
        .flat_map(|(_, file)| file.modules.iter().cloned())
        .collect();
    let mut old_folders = BTreeSet::new();
    // Check obsolete notes before assets in case a new external edit needs their links.
    obsolete.sort_by_key(|(path, _)| path.starts_with("attachments/"));
    for (path, hash) in obsolete {
        let file = current.get_mut(&path).unwrap();
        if path.starts_with("attachments/") && !file.modules.is_disjoint(&retained_note_owners) {
            continue;
        }
        let target = root.join(&path);
        if let Some(bytes) = existing_bytes(&target)? {
            if content_hash(&bytes) != hash {
                file.external = true;
                if markdown_path(&path) {
                    retained_note_owners.extend(file.modules.iter().cloned());
                }
                continue;
            }
            fs::remove_file(target).map_err(db_err)?;
        }
        if let Some(folder) = split_note_path(&path) {
            old_folders.insert(folder.to_owned());
        }
        current.remove(&path);
    }
    save_manifest(root, &current)?;
    for folder in old_folders {
        // A folder may still contain a retained edit or a user-created file.
        let _ = fs::remove_dir(root.join(folder));
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_save_made_while_the_export_was_staged_is_kept() {
        let dir = std::env::temp_dir().join(format!("memnoter-race-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("Note.md");
        fs::write(&path, b"old export").unwrap();
        let checked = content_hash(b"old export");
        fs::write(&path, b"saved in Obsidian").unwrap();
        assert!(write_unless_changed_since(&path, b"new export", Some(Some(&checked))).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"saved in Obsidian");
        let absent = dir.join("New.md");
        fs::write(&absent, b"created meanwhile").unwrap();
        assert!(write_unless_changed_since(&absent, b"new export", Some(None)).is_err());
        assert_eq!(fs::read(&absent).unwrap(), b"created meanwhile");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "no staged file is left behind");
        fs::remove_dir_all(&dir).unwrap();
    }

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
            sections: None,
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
    fn changing_layout_keeps_external_edits_and_their_linked_assets() {
        let backup = Backup::new();
        let image = "00000000-0000-0000-0000-000000000001";
        assets::write(&backup.source, image, b"image").unwrap();
        let attachment = format!("{image}.png");
        let flat = format!("# Maps\n\n![Diagram](attachments/{attachment})\n");
        let section = format!("# Maps\n\n![Diagram](../attachments/{attachment})\n");
        let split = || Module::Ready {
            name: "Note".into(),
            filename: "Note.md".into(),
            markdown: String::new(),
            sections: Some(vec![
                Section {
                    filename: "0001 - Maps.md".into(),
                    markdown: section.clone(),
                    section: Some(1),
                },
                Section {
                    filename: "0002 - Maps.md".into(),
                    markdown: "## Maps\n".into(),
                    section: Some(2),
                },
            ]),
            attachments: BTreeMap::from([(attachment.clone(), image.into())]),
        };

        let flat_path = backup.root.join("Note.md");
        let pristine_section = backup.root.join("Note/0001 - Maps.md");
        let edited_section = backup.root.join("Note/0002 - Maps.md");
        assert!(backup
            .run(with_modules([(
                "m1",
                ready(
                    "Note",
                    &flat,
                    BTreeMap::from([(attachment.clone(), image.into()),])
                )
            )]))
            .is_empty());
        fs::write(&flat_path, format!("{flat}\nExternal flat edit\n")).unwrap();

        assert!(backup.run(with_modules([("m1", split())])).is_empty());
        assert!(fs::read_to_string(&flat_path)
            .unwrap()
            .contains("External flat edit"));
        assert_eq!(fs::read_to_string(&pristine_section).unwrap(), section);
        let changed = format!(
            "## Maps\n\nExternal section edit\n\n![Diagram](../attachments/{attachment})\n"
        );
        fs::write(&edited_section, &changed).unwrap();

        assert!(
            backup
                .run(with_modules([(
                    "m1",
                    ready("Note", &flat, BTreeMap::new())
                )]))
                .len()
                == 1
        );
        fs::write(&flat_path, &flat).unwrap();
        assert!(
            backup
                .run(with_modules([(
                    "m1",
                    ready("Note", "New note text\n", BTreeMap::new())
                )]))
                .len()
                == 1
        );

        // Once the old flat version is resolved and adopted, the edit in the
        // retired layout remains available, along with its attachment.
        assert!(backup
            .run(with_modules([(
                "m1",
                ready("Note", &flat, BTreeMap::new())
            )]))
            .is_empty());
        assert!(backup
            .run(with_modules([(
                "m1",
                ready("Note", "New note text\n", BTreeMap::new())
            )]))
            .is_empty());
        assert!(!pristine_section.exists());
        assert_eq!(fs::read_to_string(&edited_section).unwrap(), changed);
        assert_eq!(
            fs::read(backup.root.join("attachments").join(&attachment)).unwrap(),
            b"image"
        );
        let edits = edited_files(&backup.source, &backup.destination).unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].path, "Note/0002 - Maps.md");
        assert_eq!(edits[0].module_id.as_deref(), Some("m1"));
        assert_eq!(edits[0].section, Some(2));
        assert_eq!(
            edits[0].baseline_hash.as_deref(),
            Some(markdown_hash("## Maps\n").as_str())
        );
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
    fn case_insensitive_filename_collisions_keep_both_exports() {
        let backup = Backup::new();
        let snapshot = |first_title, first_body, second_body| {
            with_modules([
                ("first", ready(first_title, first_body, BTreeMap::new())),
                ("second", ready("biology", second_body, BTreeMap::new())),
            ])
        };

        assert!(backup
            .run(snapshot("Biology", "First", "Second"))
            .is_empty());
        let first = backup.root.join("Biology.md");
        let second = fs::read_dir(&backup.root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path != &first && path.extension().is_some_and(|ext| ext == "md"))
            .unwrap();
        assert_ne!(
            first.file_name().unwrap().to_string_lossy().to_lowercase(),
            second.file_name().unwrap().to_string_lossy().to_lowercase(),
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "First");
        assert_eq!(fs::read_to_string(&second).unwrap(), "Second");

        assert!(backup
            .run(snapshot("Biology", "First edit", "Second edit"))
            .is_empty());
        assert_eq!(fs::read_to_string(&first).unwrap(), "First edit");
        assert_eq!(fs::read_to_string(&second).unwrap(), "Second edit");

        assert!(backup
            .run(snapshot("BIOLOGY", "Case-only rename", "Second edit"))
            .is_empty());
        assert_eq!(fs::read_to_string(&first).unwrap(), "Case-only rename");
        assert_eq!(fs::read_to_string(&second).unwrap(), "Second edit");

        assert!(backup
            .run(with_modules([(
                "second",
                ready("biology", "First removed", BTreeMap::new())
            ),]))
            .is_empty());
        assert!(!first.exists());
        assert_eq!(fs::read_to_string(&second).unwrap(), "First removed");
    }

    #[test]
    fn manifest_save_failure_leaves_stale_files_and_next_run_adopts_written_files() {
        let backup = Backup::new();
        assert!(backup
            .run(with_modules([
                ("existing", ready("Existing", "Before", BTreeMap::new())),
                (
                    "obsolete",
                    ready("Obsolete", "Keep until commit", BTreeMap::new())
                ),
            ]))
            .is_empty());
        let snapshot = || {
            with_modules([
                ("existing", ready("Existing", "After", BTreeMap::new())),
                ("new", ready("New", "New export", BTreeMap::new())),
            ])
        };
        let existing = backup.root.join("Existing.md");
        let new = backup.root.join("New.md");
        let obsolete = backup.root.join("Obsolete.md");

        let previous = load_manifest(&backup.root).unwrap();
        let manifest = backup.root.join(MANIFEST);
        let saved_manifest = fs::read(&manifest).unwrap();
        fs::remove_file(&manifest).unwrap();
        fs::create_dir(&manifest).unwrap();
        let error = reconcile(&backup.source, &backup.root, snapshot(), previous).unwrap_err();
        assert!(error.contains(MANIFEST));
        assert_eq!(fs::read_to_string(&existing).unwrap(), "After");
        assert_eq!(fs::read_to_string(&new).unwrap(), "New export");
        assert!(obsolete.exists());

        fs::remove_dir(&manifest).unwrap();
        fs::write(&manifest, saved_manifest).unwrap();
        assert!(backup.run(snapshot()).is_empty());
        assert!(!obsolete.exists());
        assert!(backup.run(with_modules([])).is_empty());
        assert!(!existing.exists());
        assert!(!new.exists());
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

        // Once flagged for review, restoring the old bytes still protects
        // the file when its note is renamed.
        fs::write(&original, "From Memnoter").unwrap();
        let mut renamed = snapshot("Renamed");
        fs::write(&deleted, "User replacement").unwrap();
        renamed.modules.remove("delete");
        assert!(backup.run(renamed).is_empty());
        assert_eq!(fs::read_to_string(&original).unwrap(), "From Memnoter");
        assert_eq!(fs::read_to_string(&deleted).unwrap(), "User replacement");
        let edits = edited_files(&backup.source, &backup.destination).unwrap();
        assert_eq!(
            edits.iter().map(|file| (file.path.as_str(), file.note_name.as_deref())).collect::<Vec<_>>(),
            vec![("Delete.md", Some("Delete")), ("Original.md", Some("Original"))],
        );
        assert_eq!(
            fs::read_to_string(backup.root.join("Renamed.md")).unwrap(),
            "From Memnoter"
        );
    }

    #[test]
    fn review_keeps_conflicted_files_visible_until_the_note_matches() {
        let backup = Backup::new();
        let image_id = Uuid::new_v4().to_string();
        let image_name = format!("{image_id}.png");
        let snapshot = |markdown| {
            with_modules([("owner", ready("Course", markdown, BTreeMap::from([
                (image_name.clone(), image_id.clone()),
            ])))])
        };
        fs::write(backup.source.join("files").join(&image_id), "original image").unwrap();
        assert!(backup.run(snapshot("Original")).is_empty());
        fs::write(backup.root.join("Course.md"), "Outside edit").unwrap();
        let image_path = format!("attachments/{image_name}");
        fs::write(backup.root.join(&image_path), "outside image edit").unwrap();
        assert_eq!(backup.run(snapshot("Original")).len(), 1);
        let edits = edited_files(&backup.source, &backup.destination).unwrap();
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].module_id.as_deref(), Some("owner"));
        assert_eq!(edits[0].markdown.as_deref(), Some("Outside edit"));
        assert_eq!(edits[1].path, image_path);
        assert!(edits[1].markdown.is_none());

        assert_eq!(backup.run(snapshot("Outside edit")).len(), 1);
        let edits = edited_files(&backup.source, &backup.destination).unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].path, image_path);
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
