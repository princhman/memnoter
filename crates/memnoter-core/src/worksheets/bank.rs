//! Development-only authoring. The marker is created only by dev-copy --empty;
//! it is path-bound, debug-only and cannot be used with sync enabled.
use super::*;
use crate::{Core, CoreError};
use yrs::{Any, ArrayPrelim, In, MapPrelim};

pub const DEV_MARKER: &str = ".question-bank-development";
pub(crate) fn isolated(db: &crate::Db) -> bool {
    let Ok(path) = db.data_dir.canonicalize() else {
        return false;
    };
    std::fs::read_to_string(path.join(DEV_MARKER))
        .ok()
        .is_some_and(|value| value.trim() == path.to_string_lossy())
}
pub fn enabled(core: &Core) -> CommandResult<bool> {
    if !(cfg!(debug_assertions)
        && std::env::var("MEMNOTER_QUESTION_BANK_DEV").as_deref() == Ok("1")
        && std::env::var_os("MEMNOTER_DATA_DIR").and_then(|p| std::fs::canonicalize(p).ok())
            == core.data_dir().canonicalize().ok()
        && isolated(&core.db))
    {
        return Ok(false);
    }
    let conn = core.db.lock()?;
    Ok(!crate::sync::is_enabled(&conn)?)
}
pub fn get(core: &Core, module: String) -> CommandResult<Option<Bank>> {
    let conn = core.db.lock()?;
    read(&load(&conn, &module)?)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CropInput {
    pub source_pdf_file_id: String,
    pub page_index: u32,
    pub rect: [f64; 4],
    pub rotation: u16,
    pub pixel_size: [u32; 2],
    pub bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub kind: String,
    pub question_id: Option<String>,
    pub part_id: Option<String>,
    pub expected_revision_id: Option<String>,
    pub target_question_id: Option<String>,
    pub target_parent_id: Option<String>,
    pub expected_target_revision_id: Option<String>,
    pub label: Option<String>,
    pub title: Option<String>,
    pub crop_id: Option<String>,
    pub index: Option<usize>,
    pub crop: Option<CropInput>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub bank: Bank,
    pub question_id: String,
    pub part_id: String,
}
/// The parent of an empty, childless, non-root part, i.e. one that can go.
fn removable_parent(revision: &Revision, part: &str) -> Option<String> {
    let found = revision.parts.get(part)?;
    let parent = found.parent_id.clone()?;
    let childless = !revision
        .parts
        .values()
        .any(|p| p.parent_id.as_deref() == Some(part));
    (found.crop_ids.is_empty() && childless).then_some(parent)
}
fn required(value: &Option<String>) -> CommandResult<&str> {
    value
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)
}
fn input(value: serde_json::Value) -> In {
    match value {
        serde_json::Value::Object(map) => In::Map(
            map.into_iter()
                .map(|(k, v)| (k, input(v)))
                .collect::<MapPrelim>(),
        ),
        serde_json::Value::Array(array) => {
            In::Array(array.into_iter().map(input).collect::<ArrayPrelim>())
        }
        value => In::Any(Any::from_json(&value.to_string()).expect("serializable worksheet field")),
    }
}
/// Persist the labels the reader saw before this edit changes the live outline.
/// Reads stay pure; these records join the edit's existing Yjs transaction.
fn freeze_question_labels(bank: &mut Bank) -> Vec<String> {
    let mut live: Vec<_> = bank.questions.iter().filter(|(_, q)| !q.deleted)
        .map(|(id, q)| (q.order, id.clone())).collect();
    live.sort();
    let mut touched = Vec::new();
    for (index, (_, id)) in live.iter().enumerate() {
        let question = bank.questions.get_mut(id).unwrap();
        if question.title.trim().is_empty() {
            question.title = (index + 1).to_string();
            touched.push(id.clone());
        }
    }
    touched
}
/// Decimal strings avoid overflow for manually entered numeric names.
/// Include tombstones so deleting the last question does not reuse its number.
fn next_question_label(bank: &Bank) -> String {
    let maximum = bank.questions.values().filter_map(|question| {
        let title = question.title.trim();
        if title.is_empty() || !title.bytes().all(|b| b.is_ascii_digit()) { return None; }
        let number = title.trim_start_matches('0');
        Some(if number.is_empty() { "0" } else { number })
    }).max_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b))).unwrap_or("0");
    let mut digits = maximum.as_bytes().to_vec();
    for digit in digits.iter_mut().rev() {
        if *digit < b'9' {
            *digit += 1;
            return String::from_utf8(digits).expect("decimal label");
        }
        *digit = b'0';
    }
    digits.insert(0, b'1');
    String::from_utf8(digits).expect("decimal label")
}
pub fn edit(core: &Core, module: String, edit: Edit) -> Result<Receipt, CoreError> {
    if !enabled(core)? {
        return Err(
            "Question bank authoring is disabled outside an opted-in, offline development vault"
                .into(),
        );
    }
    let mut conn = core.db.lock()?;
    if crate::sync::is_enabled(&conn)? {
        return Err("Development question banks cannot sync".into());
    }
    let tx = conn.transaction().map_err(db_err)?;
    let doc = load(&tx, &module)?;
    let old = read(&doc)?;
    let mut bank = old.clone().unwrap_or_else(|| Bank {
        schema_version: 1,
        questions: BTreeMap::new(),
        revisions: BTreeMap::new(),
        attempts: BTreeMap::new(),
        answers: BTreeMap::new(),
    });
    let mut touched = freeze_question_labels(&mut bank);
    let qid = if edit.kind == "newQuestion" {
        uuid::Uuid::new_v4().to_string()
    } else {
        required(&edit.question_id)?.to_owned()
    };
    let mut revision = if edit.kind == "newQuestion" {
        let pid = uuid::Uuid::new_v4().to_string();
        Revision {
            question_id: qid.clone(),
            root_part_id: pid.clone(),
            parts: BTreeMap::from([(
                pid,
                Part {
                    parent_id: None,
                    order: 0,
                    label: String::new(),
                    crop_ids: vec![],
                },
            )]),
            crops: BTreeMap::new(),
        }
    } else {
        let question = bank
            .questions
            .get(&qid)
            .filter(|q| !q.deleted)
            .ok_or_else(invalid)?;
        if Some(question.revision_id.as_str()) != edit.expected_revision_id.as_deref() {
            return Err("This question changed. Refresh the bank and try the edit again.".into());
        }
        bank.revisions
            .get(&question.revision_id)
            .ok_or_else(invalid)?
            .clone()
    };
    let mut pid = edit
        .part_id
        .clone()
        .unwrap_or_else(|| revision.root_part_id.clone());
    if !revision.parts.contains_key(&pid) {
        return Err(invalid().into());
    }
    let mut destination: Option<(String, Revision)> = None;
    let mut receipt_target: Option<(String, String)> = None;
    match edit.kind.as_str() {
        "newQuestion" | "addCrop" => {}
        "replaceCrop" => {
            let old = revision
                .crops
                .get(required(&edit.crop_id)?)
                .ok_or_else(invalid)?;
            let crop = edit.crop.as_ref().ok_or_else(invalid)?;
            // A trim keeps the source and ownership; historical crops stay immutable.
            if old.part_id != pid
                || old.source_pdf_file_id != crop.source_pdf_file_id
                || old.page_index != crop.page_index
                || old.rotation != crop.rotation
                || crop.rect[0] < old.rect[0]
                || crop.rect[1] < old.rect[1]
                || crop.rect[0] + crop.rect[2] > old.rect[0] + old.rect[2] + f64::EPSILON
                || crop.rect[1] + crop.rect[3] > old.rect[1] + old.rect[3] + f64::EPSILON
            {
                return Err(invalid().into());
            }
        }
        "newPart" => {
            let label = required(&edit.label)?.trim();
            if label.is_empty() || label.len() > 80 {
                return Err("Enter a short part label".into());
            }
            let order = revision
                .parts
                .values()
                .filter(|p| p.parent_id.as_ref() == Some(&pid))
                .map(|p| p.order)
                .max()
                .map_or(0, |n| n + 1);
            let parent = pid;
            pid = uuid::Uuid::new_v4().to_string();
            revision.parts.insert(
                pid.clone(),
                Part {
                    parent_id: Some(parent),
                    order,
                    label: label.to_owned(),
                    crop_ids: vec![],
                },
            );
        }
        "removeCrop" | "moveCrop" | "reorderCrop" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
            let cid = required(&edit.crop_id)?;
            let crop = revision.crops.get(cid).ok_or_else(invalid)?.clone();
            let source = revision.parts.get_mut(&crop.part_id).ok_or_else(invalid)?;
            source.crop_ids.retain(|id| id != cid);
            if edit.kind == "removeCrop" {
                revision.crops.remove(cid);
                // A part is made of its crops: removing the last one of a
                // childless part removes the part, leaving no empty rows.
                if let Some(parent) = removable_parent(&revision, &crop.part_id) {
                    revision.parts.remove(&crop.part_id);
                    pid = parent;
                }
            } else {
                let target = if edit.kind == "reorderCrop" {
                    crop.part_id
                } else {
                    pid.clone()
                };
                let list = &mut revision
                    .parts
                    .get_mut(&target)
                    .ok_or_else(invalid)?
                    .crop_ids;
                let position = edit.index.unwrap_or(list.len()).min(list.len());
                list.insert(position, cid.to_owned());
                revision.crops.get_mut(cid).unwrap().part_id = target;
            }
        }
        "deleteQuestion" | "renameQuestion" | "moveQuestion" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
            if edit.kind == "renameQuestion" {
                let title = edit.title.as_deref().unwrap_or_default().trim();
                if title.is_empty() {
                    return Err("Enter a question name".into());
                }
                if title.chars().count() > 120 {
                    return Err("Enter a shorter question title".into());
                }
            }
            if edit.kind == "moveQuestion" && edit.index.is_none() {
                return Err(invalid().into());
            }
        }
        "renamePart" | "movePart" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
            let parent = revision
                .parts
                .get(&pid)
                .and_then(|p| p.parent_id.clone())
                .ok_or_else(invalid)?;
            if edit.kind == "renamePart" {
                let label = required(&edit.label)?.trim();
                if label.is_empty() || label.chars().count() > 80 {
                    return Err("Enter a short part label".into());
                }
                revision.parts.get_mut(&pid).unwrap().label = label.to_owned();
            } else {
                let mut siblings: Vec<_> = revision
                    .parts
                    .iter()
                    .filter(|(_, p)| p.parent_id.as_ref() == Some(&parent))
                    .map(|(id, p)| (p.order, id.clone()))
                    .collect();
                siblings.sort();
                siblings.retain(|(_, id)| id != &pid);
                let position = edit.index.ok_or_else(invalid)?.min(siblings.len());
                siblings.insert(position, (0, pid.clone()));
                for (order, (_, id)) in siblings.iter().enumerate() {
                    revision.parts.get_mut(id).unwrap().order = order as _;
                }
            }
        }
        "reparentPart" | "transferPart" | "promotePart" | "nestQuestion" => {
            let nest_question = edit.kind == "nestQuestion";
            if nest_question && (edit.crop.is_some() || pid != revision.root_part_id) {
                return Err("Only a whole question can be made a part with this operation".into());
            }
            if !nest_question && (edit.crop.is_some() || pid == revision.root_part_id) {
                return Err("Only a part can be moved into another row or made a question".into());
            }
            let mut subtree = std::collections::HashSet::new();
            let mut pending = vec![pid.clone()];
            while let Some(id) = pending.pop() {
                if subtree.insert(id.clone()) {
                    pending.extend(revision.parts.iter().filter_map(|(child, part)| {
                        (part.parent_id.as_ref() == Some(&id)).then(|| child.clone())
                    }));
                }
            }
            if edit.kind == "reparentPart" {
                let parent = required(&edit.target_parent_id)?;
                if !revision.parts.contains_key(parent) || subtree.contains(parent) {
                    return Err("A part cannot be moved inside itself or its descendants".into());
                }
                let mut siblings: Vec<_> = revision.parts.iter()
                    .filter(|(id, part)| id.as_str() != pid && part.parent_id.as_deref() == Some(parent))
                    .map(|(id, part)| (part.order, id.clone())).collect();
                siblings.sort();
                let position = edit.index.ok_or_else(invalid)?.min(siblings.len());
                revision.parts.get_mut(&pid).unwrap().parent_id = Some(parent.to_owned());
                siblings.insert(position, (0, pid.clone()));
                for (order, (_, id)) in siblings.iter().enumerate() {
                    revision.parts.get_mut(id).unwrap().order = order as _;
                }
            } else {
                let promote = edit.kind == "promotePart";
                let target_qid = if promote { uuid::Uuid::new_v4().to_string() }
                    else { required(&edit.target_question_id)?.to_owned() };
                if target_qid == qid { return Err(invalid().into()); }
                let mut target = if promote {
                    Revision { question_id: target_qid.clone(), root_part_id: String::new(), parts: BTreeMap::new(), crops: BTreeMap::new() }
                } else {
                    let question = bank.questions.get(&target_qid).filter(|q| !q.deleted).ok_or_else(invalid)?;
                    if Some(question.revision_id.as_str()) != edit.expected_target_revision_id.as_deref() {
                        return Err("The destination question changed. Refresh the bank and try the move again.".into());
                    }
                    bank.revisions.get(&question.revision_id).ok_or_else(invalid)?.clone()
                };
                let parent = if promote { None } else {
                    let parent = required(&edit.target_parent_id)?.to_owned();
                    if !target.parts.contains_key(&parent) { return Err(invalid().into()); }
                    Some(parent)
                };
                // The source's saved name stays attached when it becomes a part.
                // Legacy empty names have already been frozen from the old order.
                let nested_label = if nest_question {
                    let title = bank.questions.get(&qid).ok_or_else(invalid)?.title.trim();
                    let label = if title.is_empty() { required(&edit.label)?.trim() } else { title };
                    if label.is_empty() || label.chars().count() > 120 {
                        return Err("Enter a short part label".into());
                    }
                    Some(label.to_owned())
                } else { None };
                // IDs have a permanent question owner across all historical revisions.
                // Copy the full subtree with fresh identities, retaining immutable assets.
                let ids: BTreeMap<_, _> = subtree.iter().map(|id| (id.clone(), uuid::Uuid::new_v4().to_string())).collect();
                let new_pid = ids[&pid].clone();
                for id in &subtree {
                    let mut part = revision.parts[id].clone();
                    if id == &pid {
                        if let Some(label) = &nested_label { part.label = label.clone(); }
                    }
                    part.parent_id = if id == &pid { parent.clone() } else {
                        Some(ids[part.parent_id.as_ref().ok_or_else(invalid)?].clone())
                    };
                    let mut crops = Vec::new();
                    for cid in &part.crop_ids {
                        let new_cid = uuid::Uuid::new_v4().to_string();
                        let mut crop = revision.crops.get(cid).ok_or_else(invalid)?.clone();
                        crop.part_id = ids[id].clone();
                        target.crops.insert(new_cid.clone(), crop);
                        crops.push(new_cid);
                    }
                    part.crop_ids = crops;
                    target.parts.insert(ids[id].clone(), part);
                }
                if promote {
                    target.root_part_id = new_pid.clone();
                    target.parts.get_mut(&new_pid).unwrap().order = 0;
                } else {
                    let mut siblings: Vec<_> = target.parts.iter()
                        .filter(|(id, part)| *id != &new_pid && part.parent_id == parent)
                        .map(|(id, part)| (part.order, id.clone())).collect();
                    siblings.sort();
                    let position = edit.index.ok_or_else(invalid)?.min(siblings.len());
                    siblings.insert(position, (0, new_pid.clone()));
                    for (order, (_, id)) in siblings.iter().enumerate() {
                        target.parts.get_mut(id).unwrap().order = order as _;
                    }
                }
                if !nest_question {
                    revision.parts.retain(|id, _| !subtree.contains(id));
                    revision.crops.retain(|_, crop| !subtree.contains(&crop.part_id));
                }
                receipt_target = Some((target_qid.clone(), new_pid));
                destination = Some((target_qid, target));
            }
        }
        "deletePart" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
            let parent = revision
                .parts
                .get(&pid)
                .and_then(|part| part.parent_id.clone())
                .ok_or_else(invalid)?;
            let mut removed = std::collections::HashSet::new();
            let mut pending = vec![pid.clone()];
            while let Some(id) = pending.pop() {
                if !removed.insert(id.clone()) {
                    continue;
                }
                pending.extend(revision.parts.iter().filter_map(|(child_id, part)| {
                    (part.parent_id.as_ref() == Some(&id)).then(|| child_id.clone())
                }));
            }
            // Only the new revision loses this subtree; existing attempts
            // continue to reference their original parts and crop assets.
            revision.parts.retain(|id, _| !removed.contains(id));
            revision.crops.retain(|_, crop| !removed.contains(&crop.part_id));
            pid = parent;
        }
        "removePart" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
            let parent = removable_parent(&revision, &pid).ok_or_else(invalid)?;
            revision.parts.remove(&pid);
            pid = parent;
        }
        _ => return Err(invalid().into()),
    }
    let mut written = None;
    // Rename/reorder/delete change question records only. Nesting writes just
    // the destination revision and soft-deletes the source at its old revision.
    let content = !matches!(
        edit.kind.as_str(),
        "deleteQuestion" | "renameQuestion" | "moveQuestion"
    );
    if !touched.contains(&qid) { touched.push(qid.clone()); }
    let result = (|| -> CommandResult<Receipt> {
        if let Some(crop) = &edit.crop {
            if !matches!(
                edit.kind.as_str(),
                "newQuestion" | "newPart" | "addCrop" | "replaceCrop"
            ) {
                return Err(invalid());
            }
            // The bitmap is frozen at selection time; it is not reconstructed
            // from a future PDF or viewer zoom. Validate PNG dimensions as well
            // as the logical displayed-page rectangle and rotation.
            let bytes = &crop.bytes;
            if bytes.len() < 33
                || bytes.len() > 16 * 1024 * 1024
                || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
                || &bytes[12..16] != b"IHDR"
                || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != crop.pixel_size[0]
                || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != crop.pixel_size[1]
            {
                return Err("Invalid crop PNG".into());
            }
            let count: Option<i64> = tx
                .query_row(
                    "select page_count from documents where id=?1 and module_id=?2",
                    rusqlite::params![crop.source_pdf_file_id, module],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if count.is_some_and(|count| i64::from(crop.page_index) >= count) {
                return Err("The PDF page is out of range".into());
            }
            let asset = uuid::Uuid::new_v4().to_string();
            let cid = uuid::Uuid::new_v4().to_string();
            revision.crops.insert(
                cid.clone(),
                Crop {
                    part_id: pid.clone(),
                    asset_id: asset.clone(),
                    source_pdf_file_id: crop.source_pdf_file_id.clone(),
                    page_index: crop.page_index,
                    rect: crop.rect,
                    rotation: crop.rotation,
                    pixel_size: crop.pixel_size,
                },
            );
            if edit.kind == "replaceCrop" {
                let previous = required(&edit.crop_id)?;
                let list = &mut revision.parts.get_mut(&pid).unwrap().crop_ids;
                let position = list
                    .iter()
                    .position(|id| id == previous)
                    .ok_or_else(invalid)?;
                list[position] = cid;
                revision.crops.remove(previous);
            } else {
                revision.parts.get_mut(&pid).unwrap().crop_ids.push(cid);
            }
            let path = crate::files::assets::write(core.data_dir(), &asset, bytes)?;
            written = Some(path.clone());
            tx.execute(
                "insert into files(id,module_id,path,file_type) values (?1,?2,?3,'image/png')",
                rusqlite::params![asset, module, path.to_string_lossy()],
            )
            .map_err(db_err)?;
            crate::sync::record_file(&tx, &asset, &module, "image/png")?;
        } else if edit.kind == "addCrop" {
            return Err("Select a PDF crop first".into());
        }
        if edit.kind == "deleteQuestion" || edit.kind == "nestQuestion" {
            // Nesting keeps the source record pointed at its original immutable
            // revision, including the identities referenced by past attempts.
            bank.questions.get_mut(&qid).ok_or_else(invalid)?.deleted = true;
        } else if edit.kind == "renameQuestion" {
            bank.questions.get_mut(&qid).ok_or_else(invalid)?.title =
                edit.title.as_deref().unwrap_or_default().trim().to_owned();
        } else if edit.kind == "moveQuestion" {
            let mut live: Vec<_> = bank
                .questions
                .iter()
                .filter(|(_, q)| !q.deleted)
                .map(|(id, q)| (q.order, id.clone()))
                .collect();
            live.sort();
            live.retain(|(_, id)| id != &qid);
            let position = edit.index.ok_or_else(invalid)?.min(live.len());
            live.insert(position, (0, qid.clone()));
            for (order, (_, id)) in live.iter().enumerate() {
                bank.questions.get_mut(id).unwrap().order = order as _;
                if !touched.contains(id)
                    && old.as_ref().and_then(|o| o.questions.get(id)) != bank.questions.get(id)
                { touched.push(id.clone()); }
            }
        } else {
            let rid = uuid::Uuid::new_v4().to_string();
            let order = bank
                .questions
                .values()
                .map(|q| q.order)
                .max()
                .map_or(0, |n| n + 1);
            let title = edit.title.as_deref().filter(|title| !title.trim().is_empty())
                .map(str::to_owned).unwrap_or_else(|| next_question_label(&bank));
            let question = bank
                .questions
                .entry(qid.clone())
                .or_insert_with(|| Question {
                    title,
                    order,
                    revision_id: rid.clone(),
                    deleted: false,
                });
            question.revision_id = rid.clone();
            bank.revisions.insert(rid, revision);
        }
        if let Some((target_qid, target_revision)) = destination {
            let rid = uuid::Uuid::new_v4().to_string();
            if edit.kind == "promotePart" {
                let mut live: Vec<_> = bank.questions.iter().filter(|(_, q)| !q.deleted)
                    .map(|(id, q)| (q.order, id.clone())).collect();
                live.sort();
                let position = edit.index.ok_or_else(invalid)?.min(live.len());
                live.insert(position, (0, target_qid.clone()));
                let title = target_revision.parts[&target_revision.root_part_id].label.trim();
                let title = if title.is_empty() { next_question_label(&bank) } else { title.to_owned() };
                bank.questions.insert(target_qid.clone(), Question { title, order: 0, revision_id: rid.clone(), deleted: false });
                for (order, (_, id)) in live.iter().enumerate() {
                    bank.questions.get_mut(id).unwrap().order = order as _;
                    if !touched.contains(id) { touched.push(id.clone()); }
                }
            } else {
                bank.questions.get_mut(&target_qid).ok_or_else(invalid)?.revision_id = rid.clone();
                if !touched.contains(&target_qid) { touched.push(target_qid); }
            }
            bank.revisions.insert(rid, target_revision);
        }
        bank.validate()?;
        let root = doc.get_or_insert_map(ROOT);
        let mut txn = doc.transact_mut();
        if old.is_none() {
            root.insert(&mut txn, "schemaVersion", 1);
            for key in ["questions", "revisions", "attempts", "answers"] {
                root.insert(&mut txn, key, MapPrelim::default());
            }
        }
        let Out::YMap(questions) = root.get(&txn, "questions").ok_or_else(invalid)? else {
            return Err(invalid());
        };
        for id in &touched {
            questions.insert(
                &mut txn,
                id.as_str(),
                input(serde_json::to_value(&bank.questions[id]).map_err(db_err)?),
            );
        }
        if content {
            let Out::YMap(revisions) = root.get(&txn, "revisions").ok_or_else(invalid)? else {
                return Err(invalid());
            };
            for id in &touched {
                let rid = &bank.questions[id].revision_id;
                if old.as_ref().is_some_and(|previous| previous.revisions.contains_key(rid)) { continue; }
                revisions.insert(&mut txn, rid.as_str(), input(serde_json::to_value(&bank.revisions[rid]).map_err(db_err)?));
            }
        }
        let update = txn.encode_update_v1();
        drop(txn);
        admit(&tx, &module, old, &doc)?;
        tx.execute(
            "insert into contents_updates(module_id,bytes,created_at) values (?1,?2,?3)",
            rusqlite::params![module, update, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(db_err)?;
        crate::sync::record_update(&tx, &module, &update)?;
        tx.commit().map_err(db_err)?;
        let (question_id, part_id) = receipt_target.unwrap_or((qid, pid));
        Ok(Receipt { bank, question_id, part_id })
    })();
    if result.is_err() {
        if let Some(path) = written {
            let _ = std::fs::remove_file(path);
        }
    }
    result.map_err(CoreError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::{json, Value};
    struct TestVault(
        std::path::PathBuf,
        Vec<(&'static str, Option<std::ffi::OsString>)>,
    );
    impl Drop for TestVault {
        fn drop(&mut self) {
            for (key, value) in &self.1 {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn apply(
        core: &Core,
        module: &str,
        previous: Option<&Receipt>,
        mut value: Value,
    ) -> Result<Receipt, CoreError> {
        if let Some(previous) = previous {
            value["questionId"] = json!(previous.question_id);
            value["expectedRevisionId"] =
                json!(previous.bank.questions[&previous.question_id].revision_id);
            if value.get("partId").is_none() {
                value["partId"] = json!(previous.part_id);
            }
        }
        edit(
            core,
            module.to_owned(),
            serde_json::from_value(value).unwrap(),
        )
    }
    #[test]
    fn development_gate_revisioned_edits_and_offline_crop_retention() {
        let _lock = super::super::DEV_TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("bank-authoring-{}", uuid::Uuid::new_v4()));
        let core = Core::open(&dir).unwrap();
        let _vault = TestVault(
            dir.clone(),
            ["MEMNOTER_DATA_DIR", "MEMNOTER_QUESTION_BANK_DEV"]
                .into_iter()
                .map(|k| (k, std::env::var_os(k)))
                .collect(),
        );
        let module = crate::create_module(&core.db, "Physics".into()).unwrap();
        let pdf = crate::add_document_bytes(
            &dir,
            &core.db,
            module.clone(),
            "Questions.pdf".into(),
            b"%PDF-1.7".to_vec(),
        )
        .unwrap();
        crate::set_document_page_count(&core.db, pdf.id.clone(), 2).unwrap();
        let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=").unwrap();
        let crop = json!({"sourcePdfFileId":pdf.id,"pageIndex":0,"rect":[0.1,0.2,0.3,0.4],"rotation":90,"pixelSize":[1,1],"bytes":png});
        assert!(apply(
            &core,
            &module,
            None,
            json!({"kind":"newQuestion","crop":crop})
        )
        .is_err());
        std::env::set_var("MEMNOTER_DATA_DIR", dir.canonicalize().unwrap());
        std::env::set_var("MEMNOTER_QUESTION_BANK_DEV", "1");
        assert!(!enabled(&core).unwrap());
        std::fs::write(dir.join(DEV_MARKER), "wrong directory").unwrap();
        assert!(!enabled(&core).unwrap());
        std::fs::write(
            dir.join(DEV_MARKER),
            dir.canonicalize().unwrap().to_string_lossy().as_bytes(),
        )
        .unwrap();
        assert!(enabled(&core).unwrap());
        assert!(crate::sync::sync_enable(&core.db, "test-account".into()).is_err());
        let first = apply(
            &core,
            &module,
            None,
            json!({"kind":"newQuestion","title":"Momentum","crop":crop}),
        )
        .unwrap();
        let original =
            first.bank.revisions[&first.bank.questions[&first.question_id].revision_id].clone();
        let mut page_two = crop.clone();
        page_two["pageIndex"] = json!(1);
        let second = apply(
            &core,
            &module,
            Some(&first),
            json!({"kind":"addCrop","crop":page_two}),
        )
        .unwrap();
        assert!(apply(
            &core,
            &module,
            Some(&first),
            json!({"kind":"addCrop","crop":crop})
        )
        .is_err());
        let root = second.part_id.clone();
        let part = apply(
            &core,
            &module,
            Some(&second),
            json!({"kind":"newPart","label":"(a)"}),
        )
        .unwrap();
        let nested = apply(
            &core,
            &module,
            Some(&part),
            json!({"kind":"newPart","label":"(i)"}),
        )
        .unwrap();
        let old_id = original.parts[&root].crop_ids[0].clone();
        let moved = apply(
            &core,
            &module,
            Some(&nested),
            json!({"kind":"moveCrop","cropId":old_id}),
        )
        .unwrap();
        let moved_revision =
            &moved.bank.revisions[&moved.bank.questions[&moved.question_id].revision_id];
        assert_eq!(moved_revision.crops[&old_id].part_id, nested.part_id);
        assert_eq!(moved_revision.crops[&old_id].rect, [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(moved_revision.crops[&old_id].rotation, 90);
        let added = apply(
            &core,
            &module,
            Some(&moved),
            json!({"kind":"addCrop","partId":root,"crop":crop}),
        )
        .unwrap();
        let revision = &added.bank.revisions[&added.bank.questions[&added.question_id].revision_id];
        let before = revision.parts[&root].crop_ids.clone();
        let reordered = apply(
            &core,
            &module,
            Some(&added),
            json!({"kind":"reorderCrop","partId":root,"cropId":before[1],"index":0}),
        )
        .unwrap();
        let revision = &reordered.bank.revisions
            [&reordered.bank.questions[&reordered.question_id].revision_id];
        assert_eq!(
            revision.parts[&root].crop_ids,
            vec![before[1].clone(), before[0].clone()]
        );
        let removed = apply(
            &core,
            &module,
            Some(&reordered),
            json!({"kind":"removeCrop","partId":root,"cropId":before[1]}),
        )
        .unwrap();
        assert_eq!(
            removed.bank.revisions[&first.bank.questions[&first.question_id].revision_id],
            original
        );
        // Parts are made of crops: removing a part's last crop removes the
        // part, and an empty leaf part can be removed; the root cannot.
        let other = apply(
            &core,
            &module,
            None,
            json!({"kind":"newQuestion","crop":crop}),
        )
        .unwrap();
        let other_root = other.part_id.clone();
        let with_part = apply(
            &core,
            &module,
            Some(&other),
            json!({"kind":"newPart","label":"a","crop":crop}),
        )
        .unwrap();
        let rev = &with_part.bank.revisions
            [&with_part.bank.questions[&with_part.question_id].revision_id];
        let part_crop = rev.parts[&with_part.part_id].crop_ids[0].clone();
        let emptied = apply(
            &core,
            &module,
            Some(&with_part),
            json!({"kind":"removeCrop","cropId":part_crop}),
        )
        .unwrap();
        let rev =
            &emptied.bank.revisions[&emptied.bank.questions[&emptied.question_id].revision_id];
        assert!(!rev.parts.contains_key(&with_part.part_id));
        assert_eq!(emptied.part_id, other_root);
        let bare = apply(
            &core,
            &module,
            Some(&emptied),
            json!({"kind":"newPart","label":"b"}),
        )
        .unwrap();
        assert!(apply(
            &core,
            &module,
            Some(&bare),
            json!({"kind":"removePart","partId":other_root})
        )
        .is_err());
        let gone = apply(&core, &module, Some(&bare), json!({"kind":"removePart"})).unwrap();
        let rev = &gone.bank.revisions[&gone.bank.questions[&gone.question_id].revision_id];
        assert_eq!(rev.parts.len(), 1);
        assert_eq!(gone.part_id, other_root);
        let file_count = || std::fs::read_dir(dir.join("files")).unwrap().count();
        let count = file_count();
        let mut bad = crop.clone();
        bad["rect"] = json!([0.9, 0, 0.5, 1]);
        assert!(apply(
            &core,
            &module,
            Some(&removed),
            json!({"kind":"addCrop","crop":bad})
        )
        .is_err());
        assert_eq!(file_count(), count);
        let mut bad = crop.clone();
        bad["pageIndex"] = json!(2);
        assert!(apply(
            &core,
            &module,
            Some(&removed),
            json!({"kind":"addCrop","crop":bad})
        )
        .is_err());
        core.db.lock().unwrap().execute_batch("create temp trigger bank_fail before insert on contents_updates begin select raise(abort,'disk full'); end;").unwrap();
        assert!(apply(
            &core,
            &module,
            Some(&removed),
            json!({"kind":"addCrop","crop":crop})
        )
        .is_err());
        assert_eq!(file_count(), count);
        core.db
            .lock()
            .unwrap()
            .execute_batch("drop trigger bank_fail")
            .unwrap();
        let content = crate::get_content(&core.db, module.clone()).unwrap();
        assert!(crate::cleanup_files(
            &dir,
            &core.db,
            module.clone(),
            content.files.iter().map(|f| f.id.clone()).collect(),
            content.state,
            content.updates.last().unwrap().id
        )
        .unwrap()
        .is_empty());
        std::fs::remove_file(crate::files::assets::path(&dir, &pdf.id).unwrap()).unwrap();
        let offline = get(&core, module.clone()).unwrap().unwrap();
        assert_eq!(offline, gone.bank);
        for revision in offline.revisions.values() {
            for crop in revision.crops.values() {
                assert!(crate::files::assets::path(&dir, &crop.asset_id)
                    .unwrap()
                    .exists());
            }
        }
        let deleted = apply(
            &core,
            &module,
            Some(&removed),
            json!({"kind":"deleteQuestion"}),
        )
        .unwrap();
        assert!(deleted.bank.questions[&first.question_id].deleted);
        assert!(deleted.bank.answers.is_empty() && deleted.bank.attempts.is_empty());

        // Rename and reorder: questions change only their record, parts get
        // a new revision, and published revisions never change.
        let live = |bank: &Bank| {
            let mut ids: Vec<_> = bank
                .questions
                .iter()
                .filter(|(_, q)| !q.deleted)
                .map(|(id, q)| (q.order, id.clone()))
                .collect();
            ids.sort();
            ids.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
        };
        let third = apply(
            &core,
            &module,
            None,
            json!({"kind":"newQuestion","crop":crop}),
        )
        .unwrap();
        let base = third.bank.clone();
        let ids = live(&base);
        assert_eq!(ids.len(), 2);
        let revision_of = |bank: &Bank, id: &str| bank.questions[id].revision_id.clone();
        let renamed = apply(
            &core,
            &module,
            Some(&third),
            json!({"kind":"renameQuestion","title":"  A1  "}),
        )
        .unwrap();
        assert_eq!(renamed.bank.questions[&third.question_id].title, "A1");
        assert_eq!(
            revision_of(&renamed.bank, &third.question_id),
            revision_of(&base, &third.question_id),
            "renaming a question writes no revision"
        );
        assert_eq!(renamed.bank.revisions, base.revisions);
        assert!(apply(
            &core,
            &module,
            Some(&renamed),
            json!({"kind":"renameQuestion","title":"   "}),
        )
        .is_err());
        assert!(apply(
            &core,
            &module,
            Some(&renamed),
            json!({"kind":"renameQuestion","title":"x".repeat(121)})
        )
        .is_err());
        let moved_first = apply(
            &core,
            &module,
            Some(&renamed),
            json!({"kind":"moveQuestion","index":0}),
        )
        .unwrap();
        let order = live(&moved_first.bank);
        assert_eq!(order[0], third.question_id);
        assert_eq!(order[1], ids[0]);
        assert_eq!(moved_first.bank.revisions, base.revisions);
        let clamped = apply(
            &core,
            &module,
            Some(&moved_first),
            json!({"kind":"moveQuestion","index":99}),
        )
        .unwrap();
        assert_eq!(live(&clamped.bank).last(), Some(&third.question_id));
        assert!(apply(
            &core,
            &module,
            Some(&clamped),
            json!({"kind":"moveQuestion"})
        )
        .is_err());
        // Persisted: a fresh read agrees with the receipt.
        assert_eq!(get(&core, module.clone()).unwrap().unwrap(), clamped.bank);

        let with_a = apply(
            &core,
            &module,
            Some(&clamped),
            json!({"kind":"newPart","label":"a","crop":crop}),
        )
        .unwrap();
        let part_a = with_a.part_id.clone();
        let with_b = apply(
            &core,
            &module,
            Some(&with_a),
            json!({"kind":"newPart","partId":with_a.bank.revisions[&revision_of(&with_a.bank,&with_a.question_id)].root_part_id,"label":"b","crop":crop}),
        )
        .unwrap();
        let part_b = with_b.part_id.clone();
        let before_rev = revision_of(&with_b.bank, &with_b.question_id);
        let rename_part = apply(
            &core,
            &module,
            Some(&with_b),
            json!({"kind":"renamePart","partId":part_a,"label":" (z) "}),
        )
        .unwrap();
        let after_rev = revision_of(&rename_part.bank, &with_b.question_id);
        assert_ne!(before_rev, after_rev);
        assert_eq!(
            rename_part.bank.revisions[&after_rev].parts[&part_a].label,
            "(z)"
        );
        assert_eq!(
            rename_part.bank.revisions[&before_rev].parts[&part_a].label, "a",
            "the earlier revision is untouched"
        );
        let root_id = rename_part.bank.revisions[&after_rev].root_part_id.clone();
        assert!(apply(
            &core,
            &module,
            Some(&rename_part),
            json!({"kind":"renamePart","partId":root_id,"label":"x"})
        )
        .is_err());
        assert!(apply(
            &core,
            &module,
            Some(&rename_part),
            json!({"kind":"renamePart","partId":part_a,"label":"  "})
        )
        .is_err());
        assert!(apply(
            &core,
            &module,
            Some(&rename_part),
            json!({"kind":"renamePart","partId":part_a,"label":"y".repeat(81)})
        )
        .is_err());
        let move_part = apply(
            &core,
            &module,
            Some(&rename_part),
            json!({"kind":"movePart","partId":part_b,"index":0}),
        )
        .unwrap();
        let moved_rev =
            &move_part.bank.revisions[&revision_of(&move_part.bank, &with_b.question_id)];
        assert_eq!(moved_rev.parts[&part_b].order, 0);
        assert_eq!(moved_rev.parts[&part_a].order, 1);
        assert_ne!(revision_of(&move_part.bank, &with_b.question_id), after_rev);
        assert!(apply(
            &core,
            &module,
            Some(&move_part),
            json!({"kind":"movePart","partId":root_id,"index":0})
        )
        .is_err());
    }
}
