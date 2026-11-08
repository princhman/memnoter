use std::sync::Arc;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MemnoterError {
    #[error("SYNC_STALE_GENERATION")]
    StaleGeneration,
    #[error("Database unavailable. Restart the app to recover.")]
    Unavailable,
    #[error("The card was reviewed elsewhere; reload the review")]
    Conflict,
    #[error("The card no longer exists")]
    NotFound,
    #[error("{message}")]
    Storage { message: String },
}
impl From<String> for MemnoterError {
    fn from(message: String) -> Self {
        Self::Storage { message }
    }
}

impl From<memnoter_core::CoreError> for MemnoterError {
    fn from(error: memnoter_core::CoreError) -> Self {
        use memnoter_core::CoreError;
        match error {
            CoreError::StaleGeneration => Self::StaleGeneration,
            CoreError::Unavailable => Self::Unavailable,
            CoreError::Conflict => Self::Conflict,
            CoreError::NotFound => Self::NotFound,
            CoreError::Storage(message) => Self::Storage { message },
        }
    }
}
#[uniffi::export(callback_interface)]
pub trait OutboxObserver: Send + Sync {
    fn outbox_changed(&self);
}

/// A shared core. Hosts must execute these synchronous methods off the UI thread.
#[derive(uniffi::Object)]
pub struct MemnoterCore {
    core: Arc<memnoter_core::Core>,
}

#[uniffi::export]
impl MemnoterCore {
    #[uniffi::constructor]
    pub fn open(data_dir: String) -> Result<Arc<Self>, MemnoterError> {
        Ok(Arc::new(Self {
            core: Arc::new(memnoter_core::Core::open(data_dir)?),
        }))
    }
    pub fn set_outbox_observer(&self, observer: Box<dyn OutboxObserver>) {
        self.core
            .set_outbox_callback(Arc::new(move || observer.outbox_changed()));
    }
    pub fn dispatch(&self, command: String, args_json: String) -> Result<String, MemnoterError> {
        memnoter_core::dispatch(&self.core, &command, &args_json).map_err(Into::into)
    }
    /// A synchronous launch-time check; the host owns the background executor.
    pub fn daily_backup(&self) -> Result<(), MemnoterError> {
        memnoter_core::backups::daily_backup(&self.core).map_err(Into::into)
    }
}

// Native transport uses the same audited wire crypto as desktop WebCrypto.
#[uniffi::export]
pub fn sync_derive_key(passphrase: String, salt: Vec<u8>) -> Vec<u8> {
    memnoter_core::sync::crypto::derive_key(&passphrase, &salt).to_vec()
}
#[uniffi::export]
pub fn sync_crypt(
    key: Vec<u8>,
    doc: String,
    bytes: Vec<u8>,
    decrypt: bool,
) -> Result<Vec<u8>, MemnoterError> {
    let key: [u8; 32] = key.try_into().map_err(|_| MemnoterError::Storage {
        message: "Expected a 256-bit key".into(),
    })?;
    if decrypt {
        memnoter_core::sync::crypto::decrypt_blob(&key, &doc, &bytes)
    } else {
        memnoter_core::sync::crypto::encrypt_blob(&key, &doc, &bytes)
    }
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_crypto_rejects_bad_keys_and_wrong_documents() {
        assert!(sync_crypt(vec![0; 31], "note".into(), vec![], false).is_err());
        let key = vec![7; 32];
        let blob = sync_crypt(key.clone(), "note".into(), b"native".to_vec(), false).unwrap();
        assert_eq!(
            sync_crypt(key.clone(), "note".into(), blob.clone(), true).unwrap(),
            b"native"
        );
        assert!(sync_crypt(key, "other".into(), blob, true).is_err());
    }
    #[test]
    fn ffi_round_trip_and_errors_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_owned();
        let core = MemnoterCore::open(path.clone()).unwrap();
        let created = core
            .dispatch(
                "create_module".into(),
                r#"{"name":"日本語 \"Notes\""}"#.into(),
            )
            .unwrap();
        assert!(core
            .dispatch("missing".into(), "{}".into())
            .unwrap_err()
            .to_string()
            .contains("Unknown command"));
        assert!(core.dispatch("rename_module".into(), "{}".into()).is_err());
        drop(core);
        let reopened = MemnoterCore::open(path).unwrap();
        let modules: serde_json::Value =
            serde_json::from_str(&reopened.dispatch("modules".into(), "{}".into()).unwrap())
                .unwrap();
        let module: serde_json::Value = serde_json::from_str(&created).unwrap();
        assert_eq!(modules[0]["id"], module);
        assert_eq!(modules[0]["name"], "日本語 \"Notes\"");
    }
}

/// Ordered JSON actions keep the transport interface identical to dispatch.
/// Hosts must serialize calls and discard this object after a failed action.
#[derive(uniffi::Object)]
pub struct SyncSession(std::sync::Mutex<memnoter_core::sync::session::Session>);
#[uniffi::export]
impl SyncSession {
    #[uniffi::constructor]
    pub fn new(key: Vec<u8>, cursor: i64) -> Result<Arc<Self>, MemnoterError> {
        Ok(Arc::new(Self(std::sync::Mutex::new(
            memnoter_core::sync::session::Session::new(&key, cursor)?,
        ))))
    }
    pub fn drive(&self, event: String, payload: String) -> Result<String, MemnoterError> {
        use memnoter_core::sync::session::Action;
        let mut s = self.0.lock().map_err(|e| MemnoterError::Storage {
            message: e.to_string(),
        })?;
        let v: serde_json::Value =
            serde_json::from_str(&payload).map_err(|e| MemnoterError::Storage {
                message: e.to_string(),
            })?;
        let actions: Vec<Action> = match event.as_str() {
            "hello" => {
                if let Some(cursor) = v["cursor"].as_i64() {
                    s.reset_cursor(cursor);
                }
                s.hello()
            }
            "frame" => s.frame(v.as_str().ok_or_else(|| MemnoterError::Storage {
                message: "Expected frame string".into(),
            })?)?,
            "push" => s.push(
                serde_json::from_value(v).map_err(|e| MemnoterError::Storage {
                    message: e.to_string(),
                })?,
            )?,
            "blob" => {
                s.blob(
                    v["id"].as_str().ok_or("Missing blob id".to_owned())?.into(),
                    serde_json::from_value(v["bytes"].clone()).map_err(|e| {
                        MemnoterError::Storage {
                            message: e.to_string(),
                        }
                    })?,
                )?;
                vec![]
            }
            "compact" => s.compact(
                v["doc"].as_str().ok_or("Missing document".to_owned())?,
                v["cursor"].as_i64().ok_or("Missing cursor".to_owned())?,
                serde_json::from_value(v["bytes"].clone()).map_err(|e| MemnoterError::Storage {
                    message: e.to_string(),
                })?,
            )?,
            "tick" => s.tick(),
            "closed" => s.closed(
                v["code"]
                    .as_u64()
                    .and_then(|code| u16::try_from(code).ok())
                    .ok_or("Invalid close code".to_owned())?,
                v["reason"]
                    .as_str()
                    .ok_or("Missing close reason".to_owned())?
                    .into(),
            ),
            _ => {
                return Err(MemnoterError::Storage {
                    message: "Unknown session event".into(),
                })
            }
        };
        serde_json::to_string(&actions).map_err(|e| MemnoterError::Storage {
            message: e.to_string(),
        })
    }
}
#[uniffi::export]
pub fn sync_contract() -> String {
    memnoter_core::sync::session::contract().to_string()
}
#[uniffi::export]
pub fn sync_new_salt() -> Vec<u8> {
    memnoter_core::sync::crypto::new_salt().to_vec()
}
#[uniffi::export]
pub fn sync_key_check(key: Vec<u8>, check: Option<Vec<u8>>) -> Result<Vec<u8>, MemnoterError> {
    let key: [u8; 32] = key.try_into().map_err(|_| MemnoterError::Storage {
        message: "Expected 256-bit key".into(),
    })?;
    if let Some(check) = check {
        if !memnoter_core::sync::crypto::verify_key_check(&key, &check) {
            return Err(MemnoterError::Storage {
                message: "That passphrase doesn't match the one set for this account.".into(),
            });
        }
        Ok(vec![])
    } else {
        memnoter_core::sync::crypto::make_key_check(&key).map_err(Into::into)
    }
}

#[derive(uniffi::Object, Default)]
pub struct SyncFilePolicy(std::sync::Mutex<memnoter_core::sync::session::FileTransfers>);
#[uniffi::export]
impl SyncFilePolicy {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn ready(&self, id: String, now_ms: u64) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .ready(&id, now_ms)
    }
    pub fn failed(&self, id: String, now_ms: u64) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .failed(id, now_ms);
    }
    pub fn completed(&self, id: String) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completed(&id);
    }
    pub fn retain(&self, pending: Vec<String>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(&pending);
    }
    pub fn next_delay(&self, now_ms: u64) -> Option<u64> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .next_delay(now_ms)
    }
}
