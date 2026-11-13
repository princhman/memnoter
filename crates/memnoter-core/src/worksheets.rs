//! Read/preserve worksheet storage. No authoring command is exposed in this release.
//! One module-local Y.Map, outside `default`; revisions (including their part
//! and crop maps) are immutable. Unknown roots/versions quarantine mutations.
use crate::{db_err, CommandResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use yrs::{types::ToJson, updates::decoder::Decode, Doc, Map, Out, ReadTxn, Transact, Update};

pub const ROOT: &str = "worksheets";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bank {
    pub schema_version: u32,
    pub questions: BTreeMap<String, Question>,
    pub revisions: BTreeMap<String, Revision>,
    pub attempts: BTreeMap<String, Attempt>,
    pub answers: BTreeMap<String, Answer>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub title: String,
    pub order: u32,
    pub revision_id: String,
    pub deleted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub question_id: String,
    pub root_part_id: String,
    pub parts: BTreeMap<String, Part>,
    pub crops: BTreeMap<String, Crop>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Part {
    pub parent_id: Option<String>,
    pub order: u32,
    pub label: String,
    pub crop_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Crop {
    pub part_id: String,
    pub asset_id: String,
    pub source_pdf_file_id: String,
    pub page_index: u32,
    pub rect: [f64; 4],
    pub rotation: u16,
    pub pixel_size: [u32; 2],
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pin {
    pub question_id: String,
    pub revision_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub title: String,
    pub questions: Vec<Pin>,
    pub deleted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    pub attempt_id: String,
    pub revision_id: String,
    pub leaf_part_id: String,
    // The wire value is a nested Y.XmlFragment, not a JSON/HTML replacement.
    pub text: String,
    pub canvas_order: Vec<String>,
    pub canvases: BTreeMap<String, Canvas>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Canvas {
    pub width: f64,
    pub height: f64,
    pub revision: Option<InkRevision>,
    pub copies: Vec<InkRevision>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkRevision {
    pub source_id: String,
    pub preview_id: String,
}

fn invalid() -> String {
    "Invalid worksheet storage; update the app or restore a valid revision".into()
}
fn id(value: &str) -> CommandResult<()> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| invalid())
}
fn unique<'a>(mut values: impl Iterator<Item = &'a String>) -> bool {
    let mut seen = HashSet::new();
    values.all(|value| seen.insert(value))
}

/// None means a legacy note; Err means retain everything and refuse mutation.
pub fn read(doc: &Doc) -> CommandResult<Option<Bank>> {
    let txn = doc.transact();
    if txn.has_missing_updates() {
        return Err(invalid());
    }
    if txn
        .root_refs()
        .any(|(name, _)| name != "default" && name != ROOT)
    {
        return Err(invalid());
    }
    if !txn.root_refs().any(|(name, _)| name == ROOT) {
        return Ok(None);
    }
    let map = txn.get_map(ROOT).ok_or_else(invalid)?;
    let bank: Bank =
        serde_json::from_value(serde_json::to_value(map.to_json(&txn)).map_err(db_err)?)
            .map_err(|_| invalid())?;
    if bank.schema_version != 1 {
        return Err(invalid());
    }
    // Require shared maps/arrays and a real XmlFragment, rather than accepting
    // JSON lookalikes that cannot merge typed text or ordered records.
    for name in ["questions", "revisions", "attempts", "answers"] {
        let Out::YMap(records) = map.get(&txn, name).ok_or_else(invalid)? else {
            return Err(invalid());
        };
        for (_, value) in records.iter(&txn) {
            let Out::YMap(record) = value else {
                return Err(invalid());
            };
            let shared_map = |parent: &yrs::MapRef, key| -> CommandResult<yrs::MapRef> {
                match parent.get(&txn, key) {
                    Some(Out::YMap(map)) => Ok(map),
                    _ => Err(invalid()),
                }
            };
            if name == "revisions" {
                for name in ["parts", "crops"] {
                    for (_, value) in shared_map(&record, name)?.iter(&txn) {
                        let Out::YMap(value) = value else {
                            return Err(invalid());
                        };
                        if name == "parts"
                            && !matches!(value.get(&txn, "cropIds"), Some(Out::YArray(_)))
                        {
                            return Err(invalid());
                        }
                    }
                }
            }
            if name == "attempts" && !matches!(record.get(&txn, "questions"), Some(Out::YArray(_)))
            {
                return Err(invalid());
            }
            if name == "answers" {
                if !matches!(record.get(&txn, "text"), Some(Out::YXmlFragment(_)))
                    || !matches!(record.get(&txn, "canvasOrder"), Some(Out::YArray(_)))
                {
                    return Err(invalid());
                }
                for (_, canvas) in shared_map(&record, "canvases")?.iter(&txn) {
                    let Out::YMap(canvas) = canvas else {
                        return Err(invalid());
                    };
                    if !matches!(
                        canvas.get(&txn, "revision"),
                        Some(Out::Any(yrs::Any::Null | yrs::Any::Map(_)))
                    ) {
                        return Err(invalid());
                    }
                    let Some(Out::YArray(copies)) = canvas.get(&txn, "copies") else {
                        return Err(invalid());
                    };
                    use yrs::Array;
                    if copies
                        .iter(&txn)
                        .any(|v| !matches!(v, Out::Any(yrs::Any::Map(_))))
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    bank.validate()?;
    Ok(Some(bank))
}
impl Bank {
    pub fn validate(&self) -> CommandResult<()> {
        if self.schema_version != 1 {
            return Err(invalid());
        }
        for (qid, question) in &self.questions {
            id(qid)?;
            id(&question.revision_id)?;
            if self
                .revisions
                .get(&question.revision_id)
                .is_none_or(|r| &r.question_id != qid)
            {
                return Err(invalid());
            }
        }
        let mut part_owners = BTreeMap::new();
        let mut crop_versions: BTreeMap<&String, (&String, &Crop)> = BTreeMap::new();
        for (rid, revision) in &self.revisions {
            id(rid)?;
            id(&revision.question_id)?;
            if !self.questions.contains_key(&revision.question_id)
                || !revision.parts.contains_key(&revision.root_part_id)
            {
                return Err(invalid());
            }
            let mut sibling_order = HashSet::new();
            let mut owned_crops = HashSet::new();
            for (pid, part) in &revision.parts {
                id(pid)?;
                if part_owners
                    .insert(pid, &revision.question_id)
                    .is_some_and(|owner| owner != &revision.question_id)
                {
                    return Err(invalid());
                }

                if (part.parent_id.is_none()) != (pid == &revision.root_part_id)
                    || !sibling_order.insert((&part.parent_id, part.order))
                {
                    return Err(invalid());
                }
                let mut path = HashSet::new();
                let mut next = Some(pid);
                while let Some(current) = next {
                    if !path.insert(current) {
                        return Err(invalid());
                    }
                    next = revision
                        .parts
                        .get(current)
                        .ok_or_else(invalid)?
                        .parent_id
                        .as_ref();
                }
                for cid in &part.crop_ids {
                    if !owned_crops.insert(cid)
                        || revision.crops.get(cid).is_none_or(|c| &c.part_id != pid)
                    {
                        return Err(invalid());
                    }
                }
            }
            if owned_crops.len() != revision.crops.len() {
                return Err(invalid());
            }
            for (cid, crop) in &revision.crops {
                id(cid)?;
                if let Some((owner, old)) = crop_versions.insert(cid, (&revision.question_id, crop))
                {
                    if owner != &revision.question_id
                        || old.asset_id != crop.asset_id
                        || old.source_pdf_file_id != crop.source_pdf_file_id
                        || old.page_index != crop.page_index
                        || old.rect != crop.rect
                        || old.rotation != crop.rotation
                        || old.pixel_size != crop.pixel_size
                    {
                        return Err(invalid());
                    }
                }

                id(&crop.asset_id)?;
                id(&crop.source_pdf_file_id)?;
                let [x, y, w, h] = crop.rect;
                if !crop.rect.iter().all(|v| v.is_finite())
                    || x < 0.0
                    || y < 0.0
                    || w <= 0.0
                    || h <= 0.0
                    || x + w > 1.0
                    || y + h > 1.0
                    || ![0, 90, 180, 270].contains(&crop.rotation)
                    || crop.pixel_size.contains(&0)
                {
                    return Err(invalid());
                }
            }
        }
        for (aid, attempt) in &self.attempts {
            id(aid)?;
            if !unique(attempt.questions.iter().map(|p| &p.question_id)) {
                return Err(invalid());
            }
            for pin in &attempt.questions {
                if self
                    .revisions
                    .get(&pin.revision_id)
                    .is_none_or(|r| r.question_id != pin.question_id)
                {
                    return Err(invalid());
                }
            }
        }
        for (key, answer) in &self.answers {
            let expected = serde_json::to_string(&[
                &answer.attempt_id,
                &answer.revision_id,
                &answer.leaf_part_id,
            ])
            .map_err(db_err)?;
            if key != &expected {
                return Err(invalid());
            }
            let attempt = self.attempts.get(&answer.attempt_id).ok_or_else(invalid)?;
            let revision = self
                .revisions
                .get(&answer.revision_id)
                .ok_or_else(invalid)?;
            if !attempt.questions.iter().any(|p| {
                p.revision_id == answer.revision_id && p.question_id == revision.question_id
            }) || !revision.parts.contains_key(&answer.leaf_part_id)
                || revision
                    .parts
                    .values()
                    .any(|p| p.parent_id.as_ref() == Some(&answer.leaf_part_id))
                || !unique(answer.canvas_order.iter())
                || answer.canvas_order.len() != answer.canvases.len()
            {
                return Err(invalid());
            }
            for cid in &answer.canvas_order {
                if !answer.canvases.contains_key(cid) {
                    return Err(invalid());
                }
            }
            for (cid, canvas) in &answer.canvases {
                id(cid)?;
                if !canvas.width.is_finite()
                    || !canvas.height.is_finite()
                    || canvas.width <= 0.0
                    || canvas.width > 100_000.0
                    || canvas.height <= 0.0
                    || canvas.height > 1_000_000.0
                {
                    return Err(invalid());
                }
                for ink in canvas.revision.iter().chain(&canvas.copies) {
                    id(&ink.source_id)?;
                    id(&ink.preview_id)?;
                }
            }
        }
        Ok(())
    }
    pub fn assets(&self) -> HashSet<String> {
        let mut files = HashSet::new();
        for r in self.revisions.values() {
            for c in r.crops.values() {
                files.insert(c.asset_id.clone());
                files.insert(c.source_pdf_file_id.clone());
            }
        }
        for a in self.answers.values() {
            for c in a.canvases.values() {
                for ink in c.revision.iter().chain(&c.copies) {
                    files.insert(ink.source_id.clone());
                    files.insert(ink.preview_id.clone());
                }
            }
        }
        files
    }
}

pub(crate) fn load(conn: &Connection, module: &str) -> CommandResult<Doc> {
    let doc = Doc::new();
    let state: Vec<u8> = conn
        .query_row(
            "select state from contents where module_id=?1",
            [module],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    let mut stmt = conn
        .prepare("select bytes from contents_updates where module_id=?1 order by id")
        .map_err(db_err)?;
    let updates = stmt
        .query_map([module], |r| r.get::<_, Vec<u8>>(0))
        .map_err(db_err)?;
    for bytes in std::iter::once(Ok(state)).chain(updates) {
        let bytes = bytes.map_err(db_err)?;
        if !bytes.is_empty() {
            doc.transact_mut()
                .apply_update(Update::decode_v1(&bytes).map_err(db_err)?)
                .map_err(db_err)?;
        }
    }
    if doc.transact().has_missing_updates() {
        return Err(invalid());
    }
    Ok(doc)
}

pub(crate) fn preserve_history(old: &Bank, new: &Bank) -> CommandResult<()> {
    for (id, value) in &old.revisions {
        if new.revisions.get(id) != Some(value) {
            return Err("Worksheet revisions are immutable".into());
        }
    }
    for (id, value) in &old.attempts {
        if new
            .attempts
            .get(id)
            .is_none_or(|a| a.questions != value.questions)
        {
            return Err("Worksheet attempts must keep their pinned revisions".into());
        }
    }
    Ok(())
}

/// Generic local writes cannot erase future roots or rewrite pinned history.
/// Incoming sync remains opaque/preserved; unknown data is quarantined on read.
pub(crate) fn admit(
    conn: &Connection,
    module: &str,
    old: Option<Bank>,
    after: &Doc,
) -> CommandResult<()> {
    let new = read(after)?;
    if let Some(old) = old {
        preserve_history(&old, new.as_ref().ok_or_else(invalid)?)?;
    }
    if let Some(bank) = new {
        let mut requirements = Vec::new();
        for revision in bank.revisions.values() {
            for crop in revision.crops.values() {
                requirements.push((&crop.asset_id, "image/"));
                requirements.push((&crop.source_pdf_file_id, "application/pdf"));
            }
        }
        for answer in bank.answers.values() {
            for canvas in answer.canvases.values() {
                for ink in canvas.revision.iter().chain(&canvas.copies) {
                    requirements.push((&ink.source_id, "application/vnd.memnoter.drawing+json"));
                    requirements.push((&ink.preview_id, "image/png"));
                }
            }
        }
        for (file, expected) in requirements {
            use rusqlite::OptionalExtension;
            let mime: Option<String> = conn
                .query_row(
                    "select file_type from files where id=?1 and module_id=?2
                union select 'application/pdf' from documents where id=?1 and module_id=?2",
                    rusqlite::params![file, module],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if !mime.is_some_and(|mime| {
                if expected == "image/" {
                    mime.starts_with(expected)
                } else {
                    mime == expected
                }
            }) {
                return Err(
                    "Worksheet asset is missing, has an invalid type or belongs to another module"
                        .into(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
