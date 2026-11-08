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
        memnoter_core::backups::spawn_daily_backup(self.core.clone())
            .join()
            .map_err(|_| MemnoterError::Storage {
                message: "Backup worker panicked".into(),
            })?;
        Ok(())
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
