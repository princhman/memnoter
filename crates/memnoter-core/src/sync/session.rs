//! Transport-independent sync decisions. Execute actions in order; discard the
//! session after any failed action and reconnect from the durable cursor.
use super::crypto;
use crate::CommandResult;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../../apps/sync/test/fixtures/protocol.json"
    ))
    .unwrap()
}
#[derive(Serialize, Debug)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Action {
    Send { text: String },
    Ack { max_id: i64 },
    Cursor { cursor: i64 },
    Apply { entries: Vec<Value>, cursor: i64 },
    Upload { id: String, bytes: Vec<u8> },
    Download { id: String },
    Snapshot { doc: String, cursor: i64 },
    Reconnect { delay_ms: u64 },
    Close { code: u16, reason: String },
    Ready,
    SignedOut,
}
#[derive(Deserialize)]
pub struct Row {
    pub id: i64,
    pub doc: String,
    pub bytes: Vec<u8>,
}
pub struct Session {
    key: [u8; 32],
    cursor: i64,
    ready: bool,
    inflight: Option<(i64, i64)>,
    next_id: i64,
    awaiting_pong: bool,
    attempts: u32,
    blobs: HashMap<String, Vec<u8>>,
}
impl Session {
    pub fn new(key: &[u8], cursor: i64) -> CommandResult<Self> {
        Ok(Self {
            key: key.try_into().map_err(|_| "Expected 256-bit key")?,
            cursor,
            ready: false,
            inflight: None,
            next_id: 1,
            awaiting_pong: false,
            attempts: 0,
            blobs: HashMap::new(),
        })
    }
    fn send(value: Value) -> Action {
        Action::Send {
            text: value.to_string(),
        }
    }
    pub fn hello(&mut self) -> Vec<Action> {
        self.ready = false;
        self.inflight = None;
        self.awaiting_pong = false;
        vec![Self::send(
            json!({"t":"hello", "cursor":self.cursor,"v":contract()["version"]}),
        )]
    }
    pub fn blob(&mut self, id: String, bytes: Vec<u8>) -> CommandResult<()> {
        if bytes.len() > contract()["MAX_LARGE_BLOB_BYTES"].as_u64().unwrap() as usize {
            return Err("Blob too large".into());
        }
        self.blobs.insert(id, bytes);
        Ok(())
    }
    pub fn read_blob_ref(bytes: &[u8]) -> Option<String> {
        if bytes.len() != 33 || bytes[0] != 2 {
            return None;
        }
        let id = std::str::from_utf8(&bytes[1..]).ok()?;
        id.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            .then(|| id.to_owned())
    }
    pub fn frame(&mut self, text: &str) -> CommandResult<Vec<Action>> {
        if text == "pong" {
            self.awaiting_pong = false;
            self.attempts = 0;
            return Ok(vec![]);
        }
        if text.len() > contract()["MAX_FRAME_BYTES"].as_u64().unwrap() as usize {
            return Err("Frame too large".into());
        }
        let m: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let number = |k: &str| m[k].as_i64().ok_or_else(|| format!("Invalid {k}"));
        match m["t"].as_str() {
            Some("entries") => {
                let mut entries = vec![];
                let mut cursor = self.cursor;
                for e in m["entries"].as_array().ok_or("Invalid entries")? {
                    let doc = e["doc"].as_str().ok_or("Invalid document")?;
                    let mut blob = B64
                        .decode(e["data"].as_str().ok_or("Invalid data")?)
                        .map_err(|e| e.to_string())?;
                    if let Some(id) = Self::read_blob_ref(&blob) {
                        match self.blobs.get(&id) {
                            Some(bytes) => blob = bytes.clone(),
                            None => return Ok(vec![Action::Download { id }]),
                        }
                    }
                    let bytes = crypto::decrypt_blob(&self.key, doc, &blob)?;
                    cursor = cursor.max(e["seq"].as_i64().ok_or("Invalid sequence")?);
                    entries.push(json!({"seq":e["seq"],"doc":doc,"bytes":bytes}));
                }
                self.blobs.clear();
                self.cursor = cursor;
                Ok(if entries.is_empty() {
                    vec![]
                } else {
                    vec![Action::Apply { entries, cursor }]
                })
            }
            Some("ready") => {
                self.cursor = self.cursor.max(number("head")?);
                self.ready = true;
                Ok(vec![
                    Action::Cursor {
                        cursor: self.cursor,
                    },
                    Action::Ready,
                ])
            }
            Some("ack") => {
                if let Some((id, max_id)) = self.inflight {
                    if id == number("id")? {
                        self.cursor = self.cursor.max(number("seq")?);
                        self.inflight = None;
                        return Ok(vec![
                            Action::Ack { max_id },
                            Action::Cursor {
                                cursor: self.cursor,
                            },
                            Action::Ready,
                        ]);
                    }
                }
                Ok(vec![])
            }
            Some("compact-hint") if self.cursor >= number("upTo")? => Ok(vec![Action::Snapshot {
                doc: m["doc"].as_str().ok_or("Invalid doc")?.into(),
                cursor: self.cursor,
            }]),
            Some("error") => {
                let reason = m["message"].as_str().unwrap_or("Sync error").to_string();
                if m["fatal"] == true {
                    Ok(vec![Action::Close { code: 1008, reason }])
                } else {
                    Err(reason)
                }
            }
            _ => Ok(vec![]),
        }
    }
    fn storable(&self, blob: Vec<u8>, actions: &mut Vec<Action>) -> CommandResult<Vec<u8>> {
        let c = contract();
        if blob.len() > c["MAX_LARGE_BLOB_BYTES"].as_u64().unwrap() as usize {
            return Err("A note change is too large to sync".into());
        }
        if blob.len() <= c["MAX_BLOB_BYTES"].as_u64().unwrap() as usize {
            return Ok(blob);
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut reference = vec![2];
        reference.extend_from_slice(id.as_bytes());
        actions.push(Action::Upload { id, bytes: blob });
        Ok(reference)
    }
    pub fn push(&mut self, rows: Vec<Row>) -> CommandResult<Vec<Action>> {
        if !self.ready || self.inflight.is_some() || rows.is_empty() {
            return Ok(vec![]);
        }
        let max_id = rows.last().unwrap().id;
        let mut grouped: Vec<(String, Vec<Vec<u8>>, bool)> = vec![];
        for row in rows {
            let index = grouped
                .iter()
                .position(|g| g.0 == row.doc)
                .unwrap_or_else(|| {
                    grouped.push((row.doc.clone(), vec![], false));
                    grouped.len() - 1
                });
            if row.bytes.is_empty() {
                grouped[index].2 = true;
            } else {
                grouped[index].1.push(row.bytes);
            }
        }
        let mut actions = vec![];
        let mut entries = vec![];
        for (doc, updates, drop) in grouped {
            if drop {
                entries.push(json!({"doc":doc,"drop":true}));
                continue;
            }
            // yrs accepts Yjs v1 updates; fall back to separate updates if a
            // future host enqueues an unsupported encoding.
            let updates = if updates.len() > 1 {
                match yrs::merge_updates_v1(updates.iter().map(Vec::as_slice)) {
                    Ok(merged) => vec![merged],
                    Err(_) => updates,
                }
            } else {
                updates
            };
            for update in updates {
                let blob = self.storable(
                    crypto::encrypt_blob(&self.key, &doc, &update)?,
                    &mut actions,
                )?;
                entries.push(json!({"doc":doc,"data":B64.encode(blob)}));
            }
        }
        let id = self.next_id;
        let frame = json!({"t":"push","id":id,"entries":entries});
        if frame.to_string().len() > contract()["MAX_FRAME_BYTES"].as_u64().unwrap() as usize {
            return Err("Push frame too large".into());
        }
        self.next_id += 1;
        self.inflight = Some((id, max_id));
        actions.push(Self::send(frame));
        Ok(actions)
    }
    pub fn compact(
        &self,
        doc: &str,
        cursor: i64,
        bytes: Option<Vec<u8>>,
    ) -> CommandResult<Vec<Action>> {
        let mut actions = vec![];
        let frame = if let Some(bytes) = bytes {
            let blob =
                self.storable(crypto::encrypt_blob(&self.key, doc, &bytes)?, &mut actions)?;
            json!({"t":"compact","doc":doc,"upTo":cursor,"data":B64.encode(blob)})
        } else {
            json!({"t":"drop","doc":doc})
        };
        actions.push(Self::send(frame));
        Ok(actions)
    }
    /// Called once per contract PING_EVERY_MS by the transport's clock.
    pub fn tick(&mut self) -> Vec<Action> {
        if self.awaiting_pong {
            return vec![Action::Close {
                code: 4002,
                reason: "ping timeout".into(),
            }];
        }
        self.awaiting_pong = true;
        vec![Action::Send {
            text: "ping".into(),
        }]
    }
    pub fn closed(&mut self, code: u16, reason: String) -> Vec<Action> {
        self.ready = false;
        self.inflight = None;
        if code == 4003 {
            return vec![Action::SignedOut];
        }
        if code == 1008 {
            return vec![Action::Close { code, reason }];
        }
        let mut random = [0u8; 8];
        use aes_gcm::aead::{rand_core::RngCore, OsRng};
        OsRng.fill_bytes(&mut random);
        let jitter = 0.75 + (u64::from_le_bytes(random) as f64 / u64::MAX as f64) * 0.5;
        let base = (1000u64 << self.attempts.min(5)).min(30000);
        self.attempts = self.attempts.saturating_add(1);
        vec![Action::Reconnect {
            delay_ms: (base as f64 * jitter) as u64,
        }]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_reconnect_drops_and_ack_contract() {
        let c = contract();
        let mut s = Session::new(&[7; 32], 42).unwrap();
        let hello = serde_json::to_value(s.hello()).unwrap();
        let frame: Value = serde_json::from_str(hello[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(frame, json!({"t":"hello","cursor":42,"v":c["version"]}));
        s.frame(r#"{"t":"ready","head":45}"#).unwrap();
        let push = s
            .push(vec![
                Row {
                    id: 1,
                    doc: "note".into(),
                    bytes: vec![1],
                },
                Row {
                    id: 2,
                    doc: "note".into(),
                    bytes: vec![],
                },
                Row {
                    id: 3,
                    doc: "note".into(),
                    bytes: vec![],
                },
            ])
            .unwrap();
        let Action::Send { text } = &push[0] else {
            panic!()
        };
        let frame: Value = serde_json::from_str(text).unwrap();
        assert_eq!(frame["entries"], json!([{"doc":"note","drop":true}]));
        assert!(s
            .frame(r#"{"t":"ack","id":9,"seq":90}"#)
            .unwrap()
            .is_empty());
        assert!(matches!(
            s.frame(r#"{"t":"ack","id":1,"seq":46}"#).unwrap()[0],
            Action::Ack { max_id: 3 }
        ));
        assert!(matches!(s.tick()[0], Action::Send { .. }));
        assert!(matches!(s.tick()[0], Action::Close { code: 4002, .. }));
        assert!(matches!(
            s.closed(4003, String::new())[0],
            Action::SignedOut
        ));
        let mut reference = vec![2];
        reference.extend_from_slice(c["blobRef"]["id"].as_str().unwrap().as_bytes());
        assert_eq!(
            Session::read_blob_ref(&reference).unwrap(),
            c["blobRef"]["id"]
        );
        reference[1] = b'X';
        assert!(Session::read_blob_ref(&reference).is_none());
    }
}
