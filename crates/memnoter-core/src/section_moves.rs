use crate::{db_err, sync, CommandResult, ContentUpdate, Db};
use chrono::Utc;
use rusqlite::params;
use yrs::{updates::decoder::Decode, Transact, Update};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionEdit {
    module_id: String,
    expected_state: Vec<u8>,
    expected_update_id: i64,
    bytes: Vec<u8>,
}

// A section transfer commits both Yjs edits, image leases and card ownership
// together. Revision checks reject a concurrent edit instead of deleting stale
// content; no half-move is published if validation or persistence fails.
pub fn move_section(
    db: &Db,
    edits: Vec<SectionEdit>,
    card_ids: Vec<String>,
) -> CommandResult<Vec<ContentUpdate>> {
    if edits.is_empty()
        || edits.len() > 2
        || (edits.len() == 2 && edits[0].module_id == edits[1].module_id)
    {
        return Err("Invalid section move".into());
    }
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(db_err)?;
    let mut receipts = Vec::new();
    for edit in &edits {
        let (state, latest): (Vec<u8>, i64) = tx.query_row(
            "select state, coalesce((select max(id) from contents_updates where module_id=?1),0)
             from contents where module_id=?1",
            [&edit.module_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(db_err)?;
        if state != edit.expected_state || latest != edit.expected_update_id {
            return Err("A note changed during the move. Please drag the section again.".into());
        }
        let doc = crate::worksheets::load(&tx, &edit.module_id)?;
        let before = crate::worksheets::read(&doc)?;
        let admitted = crate::worksheets::admitted_assets(&doc);
        doc.transact_mut()
            .apply_update(Update::decode_v1(&edit.bytes).map_err(db_err)?)
            .map_err(db_err)?;
        crate::worksheets::admit(&tx, &edit.module_id, before, &admitted, &doc)?;
        crate::asset_refs::retain_module(&tx, &edit.module_id)?;
        tx.execute(
            "insert into contents_updates(module_id,bytes,created_at) values (?1,?2,?3)",
            params![edit.module_id, edit.bytes, Utc::now().timestamp_millis()],
        )
        .map_err(db_err)?;
        receipts.push(ContentUpdate {
            id: tx.last_insert_rowid(),
            bytes: edit.bytes.clone(),
        });
        // Source before destination: remote derived indexes see the removal
        // before admitting the same card identities in their new module.
        sync::record_update(&tx, &edit.module_id, &edit.bytes)?;
        crate::asset_refs::retain_module(&tx, &edit.module_id)?;
        crate::search::invalidate_indexes(&tx, &edit.module_id)?;
    }
    if edits.len() == 2 {
        for id in card_ids {
            let changed = tx
                .execute(
                    "update cards set module_id=?3 where id=?1 and module_id=?2",
                    params![id, edits[0].module_id, edits[1].module_id],
                )
                .map_err(db_err)?;
            if changed == 0 {
                continue;
            }
            // Seed the destination review document as well as preserving the
            // local FSRS rows. Deleting the old module must not lose history.
            sync::record_review(&tx, &id, None, None)?;
            let logs: Vec<i64> = tx
                .prepare("select id from review_log where card_id=?1")
                .map_err(db_err)?
                .query_map([&id], |row| row.get(0))
                .map_err(db_err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(db_err)?;
            for log in logs {
                sync::record_review(&tx, &id, Some(log), None)?;
            }
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(receipts)
}
