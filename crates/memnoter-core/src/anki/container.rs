use crate::CommandResult;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Packages from other tools can be hostile: no single media file or
/// decompressed collection may exceed these.
const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COLLECTION_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Version {
    Legacy,
    Latest,
}

#[derive(Debug)]
pub struct AnkiArchive {
    path: PathBuf,
    version: Version,
    /// Media file name -> name of its zip entry.
    media: HashMap<String, String>,
}

/// A decompressed collection database, deleted when dropped.
pub struct CollectionFile(PathBuf);
impl CollectionFile {
    pub fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for CollectionFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn unzip_err(error: impl std::fmt::Display) -> String {
    format!("This is not a valid Anki package: {error}")
}

fn zstd_decode(bytes: &[u8], limit: u64) -> CommandResult<Vec<u8>> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(bytes).map_err(unzip_err)?;
    let mut out = Vec::new();
    (&mut decoder)
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(unzip_err)?;
    if out.len() as u64 > limit {
        return Err("The Anki package contains a file that is too large to import".into());
    }
    Ok(out)
}

impl AnkiArchive {
    pub fn open(path: &Path) -> CommandResult<Self> {
        let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
            .map_err(unzip_err)?;
        let version = match read_entry(&mut zip, "meta", 1024)? {
            // PackageMetadata { version = 1 }: 1 and 2 are the legacy containers.
            Some(meta) => match proto_fields(&meta).iter().find(|(field, _)| *field == 1) {
                Some((_, Proto::Varint(3))) => Version::Latest,
                Some((_, Proto::Varint(1 | 2))) | None => Version::Legacy,
                Some((_, Proto::Varint(other))) => {
                    return Err(format!(
                        "This Anki package version ({other}) is not supported"
                    ))
                }
                Some(_) => Version::Legacy,
            },
            None => Version::Legacy,
        };
        let listing = read_entry(&mut zip, "media", MAX_COLLECTION_BYTES)?
            .ok_or("This Anki package has no media list")?;
        let media = match version {
            Version::Legacy => {
                let map: HashMap<String, String> =
                    serde_json::from_slice(&listing).map_err(unzip_err)?;
                map.into_iter().map(|(entry, name)| (name, entry)).collect()
            }
            Version::Latest => {
                // MediaEntries { repeated MediaEntry entries = 1 }, each with
                // name = 1; the zip entry is its index unless 255 overrides it.
                let listing = zstd_decode(&listing, MAX_COLLECTION_BYTES)?;
                let mut media = HashMap::new();
                for (index, (field, value)) in proto_fields(&listing).into_iter().enumerate() {
                    if let (1, Proto::Bytes(entry)) = (field, value) {
                        let mut name = None;
                        let mut zip_name = index.to_string();
                        for (field, value) in proto_fields(&entry) {
                            match (field, value) {
                                (1, Proto::Bytes(bytes)) => {
                                    name = String::from_utf8(bytes).ok();
                                }
                                (255, Proto::Varint(entry)) => zip_name = entry.to_string(),
                                _ => {}
                            }
                        }
                        if let Some(name) = name {
                            media.insert(name, zip_name);
                        }
                    }
                }
                media
            }
        };
        Ok(Self {
            path: path.to_owned(),
            version,
            media,
        })
    }

    pub fn media_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.media.keys().cloned().collect();
        names.sort();
        names
    }

    pub fn has_media(&self, name: &str) -> bool {
        self.media.contains_key(name)
    }

    /// Extracts the collection database to a scratch file.
    pub(super) fn collection(&self) -> CommandResult<CollectionFile> {
        let mut zip = zip::ZipArchive::new(File::open(&self.path).map_err(|e| e.to_string())?)
            .map_err(unzip_err)?;
        let mut bytes = None;
        for name in [
            "collection.anki21b",
            "collection.anki21",
            "collection.anki2",
        ] {
            if let Some(found) = read_entry(&mut zip, name, MAX_COLLECTION_BYTES)? {
                bytes = Some(if name.ends_with('b') {
                    zstd_decode(&found, MAX_COLLECTION_BYTES)?
                } else {
                    found
                });
                break;
            }
        }
        let bytes = bytes.ok_or("This Anki package has no collection")?;
        let path = std::env::temp_dir().join(format!("memnoter-anki-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(CollectionFile(path))
    }

    pub fn read_media(&self, name: &str) -> CommandResult<Vec<u8>> {
        let entry = self
            .media
            .get(name)
            .ok_or_else(|| format!("Media file not found: {name}"))?;
        let mut zip = zip::ZipArchive::new(File::open(&self.path).map_err(|e| e.to_string())?)
            .map_err(unzip_err)?;
        let bytes = read_entry(&mut zip, entry, MAX_MEDIA_BYTES)?
            .ok_or_else(|| format!("Media file not found: {name}"))?;
        match self.version {
            Version::Legacy => Ok(bytes),
            Version::Latest => zstd_decode(&bytes, MAX_MEDIA_BYTES),
        }
    }
}

fn read_entry(
    zip: &mut zip::ZipArchive<File>,
    name: &str,
    limit: u64,
) -> CommandResult<Option<Vec<u8>>> {
    let file = match zip.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(unzip_err(error)),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(unzip_err)?;
    if bytes.len() as u64 > limit {
        return Err("The Anki package contains a file that is too large to import".into());
    }
    Ok(Some(bytes))
}

pub(super) enum Proto {
    Varint(u64),
    Bytes(Vec<u8>),
}

/// The top-level fields of a protobuf message; anything malformed ends the
/// scan, since callers only look for fields they know.
pub(super) fn proto_fields(mut bytes: &[u8]) -> Vec<(u32, Proto)> {
    fn varint(bytes: &mut &[u8]) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let (&byte, rest) = bytes.split_first()?;
            *bytes = rest;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
    let mut fields = Vec::new();
    while !bytes.is_empty() {
        let Some(key) = varint(&mut bytes) else { break };
        let field = (key >> 3) as u32;
        match key & 7 {
            0 => match varint(&mut bytes) {
                Some(value) => fields.push((field, Proto::Varint(value))),
                None => break,
            },
            2 => {
                let Some(length) = varint(&mut bytes) else {
                    break;
                };
                let length = length as usize;
                if length > bytes.len() {
                    break;
                }
                fields.push((field, Proto::Bytes(bytes[..length].to_vec())));
                bytes = &bytes[length..];
            }
            1 if bytes.len() >= 8 => bytes = &bytes[8..],
            5 if bytes.len() >= 4 => bytes = &bytes[4..],
            _ => break,
        }
    }
    fields
}
