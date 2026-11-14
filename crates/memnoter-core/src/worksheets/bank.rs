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
            return Err("This question changed. Refresh the bank before adding this crop.".into());
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
    match edit.kind.as_str() {
        "newQuestion" | "addCrop" => {}
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
        "deleteQuestion" => {
            if edit.crop.is_some() {
                return Err(invalid().into());
            }
        }
        _ => return Err(invalid().into()),
    }
    let mut written = None;
    let result = (|| -> CommandResult<Receipt> {
        if let Some(crop) = &edit.crop {
            if !matches!(edit.kind.as_str(), "newQuestion" | "newPart" | "addCrop") {
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
            revision.parts.get_mut(&pid).unwrap().crop_ids.push(cid);
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
        if edit.kind == "deleteQuestion" {
            bank.questions.get_mut(&qid).ok_or_else(invalid)?.deleted = true;
        } else {
            let rid = uuid::Uuid::new_v4().to_string();
            let order = bank
                .questions
                .values()
                .map(|q| q.order)
                .max()
                .map_or(0, |n| n + 1);
            let question = bank
                .questions
                .entry(qid.clone())
                .or_insert_with(|| Question {
                    title: edit.title.clone().unwrap_or_default(),
                    order,
                    revision_id: rid.clone(),
                    deleted: false,
                });
            question.revision_id = rid.clone();
            bank.revisions.insert(rid, revision);
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
        questions.insert(
            &mut txn,
            qid.as_str(),
            input(serde_json::to_value(&bank.questions[&qid]).map_err(db_err)?),
        );
        if edit.kind != "deleteQuestion" {
            let rid = &bank.questions[&qid].revision_id;
            let Out::YMap(revisions) = root.get(&txn, "revisions").ok_or_else(invalid)? else {
                return Err(invalid());
            };
            revisions.insert(
                &mut txn,
                rid.as_str(),
                input(serde_json::to_value(&bank.revisions[rid]).map_err(db_err)?),
            );
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
        Ok(Receipt {
            bank,
            question_id: qid,
            part_id: pid,
        })
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
        assert_eq!(offline, removed.bank);
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
    }
}
