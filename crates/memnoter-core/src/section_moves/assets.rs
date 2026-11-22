use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection};
use yrs::{Any, Doc, Out, Transact, Xml, XmlElementRef, XmlFragment, XmlOut};

use crate::{db_err, files::assets, sync, CommandResult};

#[derive(Default)]
pub(super) struct Copies {
    ids: BTreeMap<String, String>,
    paths: Vec<PathBuf>,
}

impl Copies {
    pub(super) fn copy_into(
        &mut self,
        conn: &Connection,
        data_dir: &Path,
        module: &str,
        doc: &Doc,
        heading: &str,
    ) -> CommandResult<Vec<u8>> {
        rewrite(doc, heading, |id| {
            if let Some(copy) = self.ids.get(id) {
                return Ok(Some(copy.clone()));
            }
            let file_type: String = conn
                .query_row("select file_type from files where id=?1", [id], |r| {
                    r.get(0)
                })
                .map_err(|_| "Download the chapter's assets before moving it.")?;
            let bytes = std::fs::read(assets::path(data_dir, id)?).map_err(db_err)?;
            let copy = uuid::Uuid::new_v4().to_string();
            let path = assets::path(data_dir, &copy)?;
            assets::write(data_dir, &copy, &bytes)?;
            self.paths.push(path.clone());
            conn.execute(
                "insert into files(id,module_id,path,file_type) values (?1,?2,?3,?4)",
                params![
                    copy,
                    module,
                    path.to_str().ok_or("Invalid asset path")?,
                    file_type
                ],
            )
            .map_err(db_err)?;
            sync::record_file(conn, &copy, module, &file_type)?;
            self.ids.insert(id.to_owned(), copy.clone());
            Ok(Some(copy))
        })
    }

    pub(super) fn rewrite_recovery(&self, doc: &Doc, heading: &str) -> CommandResult<Vec<u8>> {
        rewrite(doc, heading, |id| Ok(self.ids.get(id).cloned()))
    }

    pub(super) fn committed(&mut self) {
        self.paths.clear();
    }
}

impl Drop for Copies {
    fn drop(&mut self) {
        for path in self.paths.drain(..) {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Could not remove an uncommitted chapter asset {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
}

fn rewrite(
    doc: &Doc,
    heading: &str,
    mut replacement: impl FnMut(&str) -> CommandResult<Option<String>>,
) -> CommandResult<Vec<u8>> {
    let root = doc.get_or_insert_xml_fragment("default");
    let mut txn = doc.transact_mut();
    let (start, length) = super::conflict::chapter_range(&root, &txn, heading)
        .ok_or("The chapter could not be located in the destination.")?;
    let mut elements: Vec<_> = root
        .children(&txn)
        .skip(start as usize)
        .take(length as usize)
        .filter_map(XmlOut::into_xml_element)
        .collect();
    while let Some(node) = elements.pop() {
        elements.extend(node.children(&txn).filter_map(XmlOut::into_xml_element));
        if let Some(id) = asset_id(&node, &txn, "fileId") {
            if let Some(copy) = replacement(&id)? {
                node.insert_attribute(&mut txn, "fileId", copy);
            }
        }
        if let Some(Out::Any(Any::Map(drawing))) = node.get_attribute(&txn, "drawing") {
            let mut values = drawing.as_ref().clone();
            for key in ["sourceId", "previewId"] {
                if let Some(Any::String(id)) = values.get(key) {
                    if let Some(copy) = replacement(id)? {
                        values.insert(key.to_string(), Any::from(copy));
                    }
                }
            }
            if &values != drawing.as_ref() {
                node.insert_attribute(&mut txn, "drawing", Any::Map(values.into()));
            }
        }
    }
    Ok(txn.encode_update_v1())
}

fn asset_id(node: &XmlElementRef, txn: &impl yrs::ReadTxn, key: &str) -> Option<String> {
    match node.get_attribute(txn, key) {
        Some(Out::Any(Any::String(id))) => Some(id.to_string()),
        _ => None,
    }
}
