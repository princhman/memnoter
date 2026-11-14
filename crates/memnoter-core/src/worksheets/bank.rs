//! Development-only authoring. The marker is created only by dev-copy --empty;
//! it is path-bound, debug-only and cannot be used with sync enabled.
use super::*;
use crate::{Core, CoreError};
use yrs::{Any, In, MapPrelim, ArrayPrelim};

pub const DEV_MARKER: &str = ".question-bank-development";
pub(crate) fn isolated(db: &crate::Db) -> bool {
    let Ok(path) = db.data_dir.canonicalize() else { return false };
    std::fs::read_to_string(path.join(DEV_MARKER)).ok().is_some_and(|value| value.trim() == path.to_string_lossy())
}
pub fn enabled(core: &Core) -> CommandResult<bool> {
    if !(cfg!(debug_assertions) && std::env::var("MEMNOTER_QUESTION_BANK_DEV").as_deref() == Ok("1")
        && std::env::var_os("MEMNOTER_DATA_DIR").and_then(|p| std::fs::canonicalize(p).ok()) == core.data_dir().canonicalize().ok()
        && isolated(&core.db)) { return Ok(false); }
    let conn=core.db.lock()?;
    Ok(!crate::sync::is_enabled(&conn)?)
}
pub fn get(core: &Core, module: String) -> CommandResult<Option<Bank>> {
    let conn=core.db.lock()?;
    read(&load(&conn,&module)?)
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CropInput {
    pub source_pdf_file_id:String, pub page_index:u32, pub rect:[f64;4], pub rotation:u16,
    pub pixel_size:[u32;2], pub bytes:Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Edit {
    pub kind:String, pub question_id:Option<String>, pub part_id:Option<String>, pub expected_revision_id:Option<String>,
    pub label:Option<String>, pub title:Option<String>, pub crop_id:Option<String>, pub index:Option<usize>, pub crop:Option<CropInput>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Receipt { pub bank:Bank, pub question_id:String, pub part_id:String }
fn required(value:&Option<String>) -> CommandResult<&str> { value.as_deref().filter(|s| !s.is_empty()).ok_or_else(invalid) }
fn input(value:serde_json::Value)->In {
    match value {
        serde_json::Value::Object(map)=>In::Map(map.into_iter().map(|(k,v)|(k,input(v))).collect::<MapPrelim>()),
        serde_json::Value::Array(array)=>In::Array(array.into_iter().map(input).collect::<ArrayPrelim>()),
        value=>In::Any(Any::from_json(&value.to_string()).expect("serializable worksheet field")),
    }
}
pub fn edit(core:&Core,module:String,edit:Edit)->Result<Receipt,CoreError> {
    if !enabled(core)? { return Err("Question bank authoring is disabled outside an opted-in, offline development vault".into()); }
    let mut conn=core.db.lock()?;
    if crate::sync::is_enabled(&conn)? { return Err("Development question banks cannot sync".into()); }
    let tx=conn.transaction().map_err(db_err)?;
    let doc=load(&tx,&module)?; let old=read(&doc)?;
    let mut bank=old.clone().unwrap_or_else(|| Bank{schema_version:1,questions:BTreeMap::new(),revisions:BTreeMap::new(),attempts:BTreeMap::new(),answers:BTreeMap::new()});
    let qid=if edit.kind=="newQuestion" { uuid::Uuid::new_v4().to_string() } else { required(&edit.question_id)?.to_owned() };
    let mut revision=if edit.kind=="newQuestion" {
        let pid=uuid::Uuid::new_v4().to_string();
        Revision{question_id:qid.clone(),root_part_id:pid.clone(),parts:BTreeMap::from([(pid,Part{parent_id:None,order:0,label:String::new(),crop_ids:vec![]})]),crops:BTreeMap::new()}
    } else {
        let question=bank.questions.get(&qid).filter(|q| !q.deleted).ok_or_else(invalid)?;
        if Some(question.revision_id.as_str()) != edit.expected_revision_id.as_deref() { return Err("This question changed. Refresh the bank before adding this crop.".into()); }
        bank.revisions.get(&question.revision_id).ok_or_else(invalid)?.clone()
    };
    let mut pid=edit.part_id.clone().unwrap_or_else(||revision.root_part_id.clone());
    if !revision.parts.contains_key(&pid) { return Err(invalid().into()); }
    match edit.kind.as_str() {
        "newQuestion"|"addCrop" => {},
        "newPart" => {
            let label=required(&edit.label)?.trim();
            if label.is_empty() || label.len()>80 { return Err("Enter a short part label".into()); }
            let order=revision.parts.values().filter(|p|p.parent_id.as_ref()==Some(&pid)).map(|p|p.order).max().map_or(0,|n|n+1);
            let parent=pid; pid=uuid::Uuid::new_v4().to_string();
            revision.parts.insert(pid.clone(),Part{parent_id:Some(parent),order,label:label.to_owned(),crop_ids:vec![]});
        },
        "removeCrop"|"moveCrop"|"reorderCrop" => {
            if edit.crop.is_some() { return Err(invalid().into()); }
            let cid=required(&edit.crop_id)?;
            let crop=revision.crops.get(cid).ok_or_else(invalid)?.clone();
            let source=revision.parts.get_mut(&crop.part_id).ok_or_else(invalid)?;
            source.crop_ids.retain(|id|id!=cid);
            if edit.kind=="removeCrop" { revision.crops.remove(cid); }
            else {
                let target=if edit.kind=="reorderCrop" {crop.part_id} else {pid.clone()};
                let list=&mut revision.parts.get_mut(&target).ok_or_else(invalid)?.crop_ids;
                let position=edit.index.unwrap_or(list.len()).min(list.len());
                list.insert(position,cid.to_owned()); revision.crops.get_mut(cid).unwrap().part_id=target;
            }
        },
        "deleteQuestion" => { if edit.crop.is_some() { return Err(invalid().into()); } },
        _=>return Err(invalid().into()),
    }
    let mut written=None;
    let result=(|| -> CommandResult<Receipt> {
        if let Some(crop)=&edit.crop {
            if !matches!(edit.kind.as_str(),"newQuestion"|"newPart"|"addCrop") { return Err(invalid()); }
            // The bitmap is frozen at selection time; it is not reconstructed
            // from a future PDF or viewer zoom. Validate PNG dimensions as well
            // as the logical displayed-page rectangle and rotation.
            let bytes=&crop.bytes;
            if bytes.len()<33 || bytes.len()>16*1024*1024 || bytes[..8] != [137,80,78,71,13,10,26,10] || &bytes[12..16]!=b"IHDR"
                || u32::from_be_bytes(bytes[16..20].try_into().unwrap())!=crop.pixel_size[0]
                || u32::from_be_bytes(bytes[20..24].try_into().unwrap())!=crop.pixel_size[1] { return Err("Invalid crop PNG".into()); }
            let count:Option<i64>=tx.query_row("select page_count from documents where id=?1 and module_id=?2",rusqlite::params![crop.source_pdf_file_id,module],|r|r.get(0)).map_err(db_err)?;
            if count.is_some_and(|count|i64::from(crop.page_index)>=count) { return Err("The PDF page is out of range".into()); }
            let asset=uuid::Uuid::new_v4().to_string(); let cid=uuid::Uuid::new_v4().to_string();
            revision.crops.insert(cid.clone(),Crop{part_id:pid.clone(),asset_id:asset.clone(),source_pdf_file_id:crop.source_pdf_file_id.clone(),page_index:crop.page_index,rect:crop.rect,rotation:crop.rotation,pixel_size:crop.pixel_size});
            revision.parts.get_mut(&pid).unwrap().crop_ids.push(cid);
            let path=crate::files::assets::write(core.data_dir(),&asset,bytes)?; written=Some(path.clone());
            tx.execute("insert into files(id,module_id,path,file_type) values (?1,?2,?3,'image/png')",rusqlite::params![asset,module,path.to_string_lossy()]).map_err(db_err)?;
            crate::sync::record_file(&tx,&asset,&module,"image/png")?;
        } else if edit.kind=="addCrop" { return Err("Select a PDF crop first".into()); }
        if edit.kind=="deleteQuestion" { bank.questions.get_mut(&qid).ok_or_else(invalid)?.deleted=true; }
        else {
            let rid=uuid::Uuid::new_v4().to_string();
            let order=bank.questions.values().map(|q|q.order).max().map_or(0,|n|n+1);
            let question=bank.questions.entry(qid.clone()).or_insert_with(||Question{title:edit.title.clone().unwrap_or_default(),order,revision_id:rid.clone(),deleted:false});
            question.revision_id=rid.clone(); bank.revisions.insert(rid,revision);
        }
        bank.validate()?;
        let root=doc.get_or_insert_map(ROOT); let mut txn=doc.transact_mut();
        if old.is_none() {
            root.insert(&mut txn,"schemaVersion",1);
            for key in ["questions","revisions","attempts","answers"] { root.insert(&mut txn,key,MapPrelim::default()); }
        }
        let Out::YMap(questions)=root.get(&txn,"questions").ok_or_else(invalid)? else {return Err(invalid())};
        questions.insert(&mut txn,qid.as_str(),input(serde_json::to_value(&bank.questions[&qid]).map_err(db_err)?));
        if edit.kind!="deleteQuestion" {
            let rid=&bank.questions[&qid].revision_id;
            let Out::YMap(revisions)=root.get(&txn,"revisions").ok_or_else(invalid)? else {return Err(invalid())};
            revisions.insert(&mut txn,rid.as_str(),input(serde_json::to_value(&bank.revisions[rid]).map_err(db_err)?));
        }
        let update=txn.encode_update_v1(); drop(txn);
        admit(&tx,&module,old,&doc)?;
        tx.execute("insert into contents_updates(module_id,bytes,created_at) values (?1,?2,?3)",rusqlite::params![module,update,chrono::Utc::now().timestamp_millis()]).map_err(db_err)?;
        crate::sync::record_update(&tx,&module,&update)?;
        tx.commit().map_err(db_err)?;
        Ok(Receipt{bank,question_id:qid,part_id:pid})
    })();
    if result.is_err() { if let Some(path)=written { let _=std::fs::remove_file(path); } }
    result.map_err(CoreError::from)
}
