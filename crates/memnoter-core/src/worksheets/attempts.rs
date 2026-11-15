//! Durable worksheet attempts and answers.
use super::*;
use crate::{Core, CoreError};
use yrs::{
    types::AsPrelim, GetString, StateVector, XmlElementPrelim, Any, Array, ArrayPrelim, In, MapPrelim, MapRef, Text, TransactionMut, Xml,
    XmlFragment, XmlFragmentPrelim, XmlOut, XmlTextPrelim,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReceipt {
    pub bank: Bank,
    pub attempt_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReceipt {
    pub bank: Bank,
}

/// Work on a freshly loaded document. Failed writes discard it and roll back
/// SQLite, including the update log; no file assets are created by these commands.
fn write<T>(
    core: &Core,
    module: &str,
    answer_owner: Option<[&str; 3]>,
    change: impl FnOnce(&mut TransactionMut<'_>, &MapRef, &Bank) -> CommandResult<T>,
) -> Result<(Bank, T), CoreError> {
    let mut conn = core.db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let doc = load(&tx, module)?;
    let old = read(&doc)?.ok_or("Create questions before starting a worksheet")?;
    let before = doc.transact().state_vector();
    if let Some(owner) = answer_owner { initialize_answer(&doc, &owner)?; }
    let (update, result) = {
        let mut txn = doc.transact_mut();
        let root = txn.get_map(ROOT).ok_or_else(invalid)?;
        let result = change(&mut txn, &root, &old)?;
        (txn.encode_diff_v1(&before), result)
    };
    admit(&tx, module, Some(old), &doc)?;
    let bank = read(&doc)?.ok_or_else(invalid)?;
    tx.execute(
        "insert into contents_updates(module_id,bytes,created_at) values (?1,?2,?3)",
        rusqlite::params![module, update, chrono::Utc::now().timestamp_millis()],
    )
    .map_err(db_err)?;
    for file in document_assets(&doc)? {
        crate::asset_refs::retain_worksheet_asset(&tx, module, &file, false)?;
    }
    crate::sync::record_update(&tx, module, &update)?;
    tx.commit().map_err(db_err)?;
    Ok((bank, result))
}

/// Seed missing answer containers with reproducible Yjs identities. Two devices
/// creating the first answer offline must target the SAME map/fragment rather
/// than competing map values (which would discard one device's entire answer).
/// Each owner gets a domain-separated 48-bit client, within JS's safe integer
/// range. This client only emits this fixed initialization, never user edits.
fn initialize_answer(doc: &Doc, owner: &[&str; 3]) -> CommandResult<()> {
    let key = serde_json::to_string(owner).map_err(db_err)?;
    let txn = doc.transact();
    let root = txn.get_map(ROOT).ok_or_else(invalid)?;
    if shared_map(&txn, &root, "answers")?.get(&txn, &key).is_some() { return Ok(()); }
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    drop(txn);
    let seed = Doc::with_client_id(initialization_client("worksheet-answer-init", &key));
    seed.transact_mut().apply_update(Update::decode_v1(&state).map_err(db_err)?).map_err(db_err)?;
    let update = {
        let mut txn = seed.transact_mut();
        let root = txn.get_map(ROOT).ok_or_else(invalid)?;
        let answers = shared_map(&txn, &root, "answers")?;
        let answer = answers.insert(&mut txn, key.as_str(), MapPrelim::default());
        answer.insert(&mut txn, "attemptId", owner[0]);
        answer.insert(&mut txn, "revisionId", owner[1]);
        answer.insert(&mut txn, "leafPartId", owner[2]);
        answer.insert(&mut txn, "text", XmlFragmentPrelim::default());
        answer.insert(&mut txn, "canvasOrder", ArrayPrelim::default());
        answer.insert(&mut txn, "canvases", MapPrelim::default());
        txn.encode_update_v1()
    };
    doc.transact_mut().apply_update(Update::decode_v1(&update).map_err(db_err)?).map_err(db_err)?;
    Ok(())
}

fn shared_map(txn: &impl ReadTxn, parent: &MapRef, key: &str) -> CommandResult<MapRef> {
    match parent.get(txn, key) {
        Some(Out::YMap(map)) => Ok(map),
        _ => Err(invalid()),
    }
}

pub fn create(
    core: &Core,
    module: String,
    title: String,
    question_ids: Vec<String>,
) -> Result<CreateReceipt, CoreError> {
    let (bank, attempt_id) = write(core, &module, None, |txn, root, bank| {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err("Enter a worksheet title of 1 to 120 characters".into());
        }
        if question_ids.is_empty() {
            return Err("Select at least one question".into());
        }
        if !unique(question_ids.iter()) {
            return Err("Select each question only once".into());
        }
        // Keep the provided selection order and pin current live revisions.
        let mut pins = Vec::with_capacity(question_ids.len());
        for qid in &question_ids {
            let question = bank.questions.get(qid).filter(|q| !q.deleted)
                .ok_or("A selected question is unavailable. Refresh the bank and try again.")?;
            pins.push(MapPrelim::from([
                ("questionId", In::from(qid.clone())),
                ("revisionId", In::from(question.revision_id.clone())),
            ]));
        }
        let attempts = shared_map(txn, root, "attempts")?;
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let attempt = attempts.insert(txn, attempt_id.as_str(), MapPrelim::default());
        attempt.insert(txn, "title", title);
        attempt.insert(txn, "deleted", false);
        let questions = attempt.insert(txn, "questions", ArrayPrelim::default());
        for pin in pins {
            questions.push_back(txn, pin);
        }
        Ok(attempt_id)
    })?;
    Ok(CreateReceipt { bank, attempt_id })
}

/// Finish only after the caller has durably drained its pending answers.
pub fn finish(core: &Core, module: String, attempt_id: String) -> Result<SaveReceipt, CoreError> {
    let (bank, ()) = write(core, &module, None, |txn, root, bank| {
        bank.attempts.get(&attempt_id).filter(|a| !a.deleted)
            .ok_or("This worksheet is unavailable")?;
        let attempts = shared_map(txn, root, "attempts")?;
        let attempt = shared_map(txn, &attempts, &attempt_id)?;
        attempt.insert(txn, "finished", true);
        Ok(())
    })?;
    Ok(SaveReceipt { bank })
}

fn editable(attempt: &Attempt) -> CommandResult<()> {
    if attempt.finished { return Err("Finished worksheet answers are read-only".into()); }
    Ok(())
}

/// Only the empty fragment or a single unformatted XmlText is editable here.
/// Inspect deltas as well as XML attributes so embeds and formatting cannot be
/// silently flattened. Yrs serializes this supported shape as raw plain text,
/// without XML escaping: Answer.text needs no decoding on the frontend.
fn plain_text_child(
    txn: &impl ReadTxn,
    fragment: &yrs::XmlFragmentRef,
) -> CommandResult<Option<yrs::XmlTextRef>> {
    let unsupported = || "This answer contains rich text that this worksheet editor cannot edit".to_owned();
    match fragment.len(txn) {
        0 => Ok(None),
        1 => {
            let Some(XmlOut::Text(text)) = fragment.get(txn, 0) else {
                return Err(unsupported());
            };
            if text.attributes(txn).next().is_some()
                || text.diff(txn, |_| ()).iter().any(|chunk| {
                    !matches!(&chunk.insert, Out::Any(Any::String(_)))
                        || chunk.attributes.as_ref().is_some_and(|attrs| !attrs.is_empty())
                })
            {
                return Err(unsupported());
            }
            Ok(Some(text))
        }
        _ => Err(unsupported()),
    }
}

pub fn save_answer(
    core: &Core,
    module: String,
    attempt_id: String,
    revision_id: String,
    leaf_part_id: String,
    text: String,
) -> Result<SaveReceipt, CoreError> {
    let (bank, ()) = write(core, &module, Some([&attempt_id, &revision_id, &leaf_part_id]), |txn, root, bank| {
        if text.len() > 1024 * 1024 {
            return Err("This answer is too long (maximum 1 MiB of text)".into());
        }
        let attempt = bank.attempts.get(&attempt_id).filter(|a| !a.deleted)
            .ok_or("This worksheet is unavailable. Refresh the bank and try again.")?;
        editable(attempt)?;
        let revision = bank.revisions.get(&revision_id)
            .filter(|revision| attempt.questions.iter().any(|pin| {
                pin.revision_id == revision_id && pin.question_id == revision.question_id
            }))
            .ok_or("This question revision does not belong to this worksheet")?;
        if !revision.parts.contains_key(&leaf_part_id)
            || revision.parts.values().any(|part| part.parent_id.as_ref() == Some(&leaf_part_id))
        {
            return Err("Answers can only be saved to a leaf part of this worksheet's pinned question".into());
        }
        let key = serde_json::to_string(&[&attempt_id, &revision_id, &leaf_part_id])
            .map_err(db_err)?;
        let fragment = answer_fragment(txn, root, &key)?.ok_or_else(invalid)?;
        if let Some(child) = plain_text_child(txn, &fragment)? {
            let len = child.len(txn);
            if len > 0 {
                child.remove_range(txn, 0, len);
            }
            if !text.is_empty() {
                child.insert(txn, 0, &text);
            }
        } else {
            fragment.insert(txn, 0, XmlTextPrelim::new(text.as_str()));
        }
        Ok(())
    })?;
    Ok(SaveReceipt { bank })
}

// Clone through typed Yrs APIs, never XML strings. AsPrelim preserves text
// deltas/marks, but XmlElement::as_prelim stringifies attributes in this Yrs
// version; copy element attributes explicitly so booleans/maps/numbers survive.
fn copy_xml(
    source: &impl ReadTxn,
    children: Vec<XmlOut>,
    target: &impl XmlFragment,
    txn: &mut TransactionMut<'_>,
    depth: usize,
    budget: &mut usize,
) -> CommandResult<()> {
    if depth > 128 || children.len() > *budget { return Err("Answer document is too complex".into()); }
    *budget -= children.len();
    for child in children {
        match child {
            XmlOut::Element(element) => {
                let copied = target.push_back(txn, XmlElementPrelim::empty(element.tag().clone()));
                for (key, value) in element.attributes(source) {
                    let Out::Any(value) = value else { return Err(invalid()); };
                    copied.insert_attribute(txn, key, value);
                }
                copy_xml(source, element.children(source).collect(), &copied, txn, depth + 1, budget)?;
            }
            XmlOut::Text(text) => {
                if text.diff(source, |_| ()).iter().any(|d| !matches!(d.insert, Out::Any(Any::String(_)))) {
                    return Err("Unsupported embedded answer content; retained unchanged".into());
                }
                let copied = target.push_back(txn, XmlTextPrelim::new(""));
                copied.apply_delta(txn, text.as_prelim(source).delta);
                for (key, value) in text.attributes(source) {
                    let Out::Any(value) = value else { return Err(invalid()); };
                    copied.insert_attribute(txn, key, value);
                }
            }
            XmlOut::Fragment(_) => return Err("Unsupported nested answer fragment; retained unchanged".into()),
        }
    }
    Ok(())
}

// Typed canonical token for optimistic concurrency, including attributes and
// formatting (XML display strings alone lose attribute types).
fn content_token(txn: &impl ReadTxn, nodes: Vec<XmlOut>, depth: usize, budget: &mut usize) -> CommandResult<serde_json::Value> {
    if depth > 128 || nodes.len() > *budget { return Err(invalid()); }
    *budget -= nodes.len();
    let mut result = Vec::new();
    for node in nodes {
        let value = match node {
            XmlOut::Element(e) => {
                let mut attrs = BTreeMap::new();
                for (k, v) in e.attributes(txn) {
                    let Out::Any(v) = v else { return Err(invalid()); };
                    attrs.insert(k.to_owned(), v);
                }
                serde_json::json!(["element", e.tag().as_ref(), attrs, content_token(txn, e.children(txn).collect(), depth + 1, budget)?])
            }
            XmlOut::Text(t) => {
                let mut attrs = BTreeMap::new();
                for (k, v) in t.attributes(txn) {
                    let Out::Any(v) = v else { return Err(invalid()); };
                    attrs.insert(k.to_owned(), v);
                }
                let mut delta = Vec::new();
                for d in t.diff(txn, |_| ()) {
                    let Out::Any(Any::String(value)) = d.insert else { return Err(invalid()); };
                    let marks: BTreeMap<_, _> = d.attributes.unwrap_or_default().into_iter().map(|(k,v)| (k.to_string(),v)).collect();
                    delta.push(serde_json::json!([value.as_ref(), marks]));
                }
                serde_json::json!(["text", attrs, delta])
            }
            XmlOut::Fragment(_) => return Err(invalid()),
        };
        result.push(value);
    }
    Ok(serde_json::Value::Array(result))
}
fn token(txn: &impl ReadTxn, fragment: &yrs::XmlFragmentRef) -> CommandResult<String> {
    serde_json::to_string(&content_token(txn, fragment.children(txn).collect(), 0, &mut 100_000)?).map_err(db_err)
}
fn answer_fragment(txn: &impl ReadTxn, root: &MapRef, key: &str) -> CommandResult<Option<yrs::XmlFragmentRef>> {
    let answers = shared_map(txn, root, "answers")?;
    match answers.get(txn, key) {
        None => Ok(None),
        Some(Out::YMap(answer)) => match answer.get(txn, "text") {
            Some(Out::YXmlFragment(f)) => Ok(Some(f)), _ => Err(invalid()),
        },
        _ => Err(invalid()),
    }
}
fn owner(bank: &Bank, attempt: &str, revision: &str, leaf: &str) -> CommandResult<String> {
    let a = bank.attempts.get(attempt).filter(|a| !a.deleted).ok_or("This worksheet is unavailable")?;
    let r = bank.revisions.get(revision).filter(|r| a.questions.iter().any(|p| p.revision_id == revision && p.question_id == r.question_id))
        .ok_or("This revision does not belong to the worksheet")?;
    if !r.parts.contains_key(leaf) || r.parts.values().any(|p| p.parent_id.as_deref() == Some(leaf)) {
        return Err("Answers require a pinned leaf part".into());
    }
    serde_json::to_string(&[attempt, revision, leaf]).map_err(db_err)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerDocument {
    document: Vec<u8>,
    expected: String,
    plain_text: Option<String>,
}
pub fn load_answer_document(core: &Core, module: String, attempt: String, revision: String, leaf: String) -> Result<AnswerDocument, CoreError> {
    let conn = core.db.lock()?;
    let doc = load(&conn, &module)?;
    let bank = read(&doc)?.ok_or_else(invalid)?;
    let key = owner(&bank, &attempt, &revision, &leaf)?;
    let txn = doc.transact();
    let root = txn.get_map(ROOT).ok_or_else(invalid)?;
    let fragment = answer_fragment(&txn, &root, &key)?;
    let isolated = Doc::new();
    let output = isolated.get_or_insert_xml_fragment("default");
    let (expected, plain_text) = if let Some(f) = fragment {
        let expected = token(&txn, &f)?;
        let plain = plain_text_child(&txn, &f).ok().map(|child| child.map(|t| t.get_string(&txn)).unwrap_or_default());
        copy_xml(&txn, f.children(&txn).collect(), &output, &mut isolated.transact_mut(), 0, &mut 100_000)?;
        (expected, plain)
    } else { ("[]".into(), Some(String::new())) };
    let document = isolated.transact().encode_state_as_update_v1(&StateVector::default());
    Ok(AnswerDocument { document, expected, plain_text })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReceipt { bank: Bank, expected: String }
pub fn save_answer_document(core: &Core, module: String, attempt: String, revision: String, leaf: String, document: Vec<u8>, expected: String) -> Result<DocumentReceipt, CoreError> {
    if document.len() > 4 * 1024 * 1024 || expected.len() > 8 * 1024 * 1024 { return Err("Answer document is too large".into()); }
    // Decode untrusted state into a disposable doc. Its updates NEVER enter the
    // module: only default's validated XML children can be transplanted.
    let isolated = Doc::new();
    let source = isolated.get_or_insert_xml_fragment("default");
    isolated.transact_mut().apply_update(Update::decode_v1(&document).map_err(db_err)?).map_err(db_err)?;
    let source_txn = isolated.transact();
    if source_txn.has_missing_updates() || source_txn.root_refs().any(|(name, _)| name != "default") { return Err(invalid().into()); }
    let next = token(&source_txn, &source)?;
    let (bank, ()) = write(core, &module, Some([&attempt, &revision, &leaf]), |txn, root, bank| {
        editable(bank.attempts.get(&attempt).ok_or_else(invalid)?)?;
        let key = owner(bank, &attempt, &revision, &leaf)?;
        let current = answer_fragment(txn, root, &key)?;
        let actual = match current.as_ref() { Some(f) => token(txn, f)?, None => "[]".into() };
        if actual == next { return Ok(()); } // lost receipt retry
        if actual != expected { return Err("This answer changed elsewhere. Your local draft is retained; reopen before resolving the conflict.".into()); }
        // Keep the shared fragment's identity. Concurrent offline replacements
        // delete only their observed children; both new versions survive as
        // sibling blocks on merge. The next open shows both for reconciliation.
        let target = current.ok_or_else(invalid)?;
        let len = target.len(txn);
        if len > 0 { target.remove_range(txn, 0, len); }
        copy_xml(&source_txn, source.children(&source_txn).collect(), &target, txn, 0, &mut 100_000)?;
        Ok(())
    })?;
    Ok(DocumentReceipt { bank, expected: next })
}

/// Attach native-persisted assets only after validating pinned answer ownership.
/// Revision pairs are atomic Any maps; canvas containers remain shared Y types.
#[allow(clippy::too_many_arguments)] // Flat native/shared-UI command contract.
pub fn save_canvas(
    core: &Core,
    module: String,
    attempt_id: String,
    revision_id: String,
    leaf_part_id: String,
    canvas_id: String,
    source_id: String,
    preview_id: String,
    expected_source_id: Option<String>,
    width: f64,
    height: f64,
    as_copy: bool,
) -> Result<SaveReceipt, CoreError> {
    let (bank, ()) = write(core, &module, Some([&attempt_id, &revision_id, &leaf_part_id]), |txn, root, bank| {
        for value in [&canvas_id, &source_id, &preview_id] { id(value)?; }
        if let Some(expected) = &expected_source_id { id(expected)?; }
        if source_id == preview_id || !width.is_finite() || !height.is_finite()
            || width <= 0.0 || width > 100_000.0 || height <= 0.0 || height > 1_000_000.0 {
            return Err("Invalid drawing dimensions or assets".into());
        }
        let attempt = bank.attempts.get(&attempt_id).filter(|a| !a.deleted)
            .ok_or("This worksheet is unavailable. Your local drawing draft is retained.")?;
        editable(attempt)?;
        let revision = bank.revisions.get(&revision_id).filter(|r| attempt.questions.iter()
            .any(|pin| pin.revision_id == revision_id && pin.question_id == r.question_id))
            .ok_or("This question revision does not belong to this worksheet")?;
        if !revision.parts.contains_key(&leaf_part_id) || revision.parts.values()
            .any(|p| p.parent_id.as_ref() == Some(&leaf_part_id)) {
            return Err("Drawings can only be saved to a leaf of the pinned question".into());
        }
        let key = serde_json::to_string(&[&attempt_id, &revision_id, &leaf_part_id]).map_err(db_err)?;
        for (other_key, answer) in &bank.answers {
            if other_key != &key && answer.canvases.contains_key(&canvas_id) {
                return Err("This drawing belongs to another answer".into());
            }
            for canvas in answer.canvases.values() {
                for ink in canvas.revision.iter().chain(&canvas.copies) {
                    if (ink.source_id == source_id && ink.preview_id != preview_id)
                        || (ink.preview_id == preview_id && ink.source_id != source_id) {
                        return Err("Drawing source and preview pairs are immutable".into());
                    }
                }
            }
        }
        let current = bank.answers.get(&key).and_then(|a| a.canvases.get(&canvas_id));
        // Retry after a durable write but lost receipt is harmless.
        if current.is_some_and(|c| c.revision.iter().chain(&c.copies)
            .any(|r| r.source_id == source_id && r.preview_id == preview_id)) { return Ok(()); }
        if !as_copy && current.and_then(|c| c.revision.as_ref()).map(|r| &r.source_id) != expected_source_id.as_ref() {
            return Err("This drawing changed. Reopen it and save a copy to keep both versions. Your local draft is retained.".into());
        }
        let answers = shared_map(txn, root, "answers")?;
        let answer = shared_map(txn, &answers, &key)?;
        let canvases = shared_map(txn, &answer, "canvases")?;
        let pair = Any::from(std::collections::HashMap::from([
            ("sourceId".to_owned(), Any::from(source_id.clone())),
            ("previewId".to_owned(), Any::from(preview_id.clone())),
        ]));
        match canvases.get(txn, canvas_id.as_str()) {
            Some(Out::YMap(canvas)) => {
                if as_copy {
                    let Some(Out::YArray(copies)) = canvas.get(txn, "copies") else { return Err(invalid()); };
                    copies.push_back(txn, pair);
                } else {
                    canvas.insert(txn, "revision", pair);
                    canvas.insert(txn, "width", width);
                    canvas.insert(txn, "height", height);
                }
            }
            None => {
                let canvas = canvases.insert(txn, canvas_id.as_str(), MapPrelim::default());
                canvas.insert(txn, "width", width);
                canvas.insert(txn, "height", height);
                canvas.insert(txn, "revision", pair);
                canvas.insert(txn, "copies", ArrayPrelim::default());
                let Some(Out::YArray(order)) = answer.get(txn, "canvasOrder") else { return Err(invalid()); };
                order.push_back(txn, canvas_id.as_str());
            }
            _ => return Err(invalid()),
        }
        Ok(())
    })?;
    Ok(SaveReceipt { bank })
}
