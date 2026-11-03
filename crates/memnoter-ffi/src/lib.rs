use std::sync::Arc;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MemnoterError {
    #[error("{message}")]
    Storage { message: String },
}
impl From<String> for MemnoterError {
    fn from(message: String) -> Self { Self::Storage { message } }
}

/// A shared core. Hosts must execute these synchronous methods off the UI thread.
#[derive(uniffi::Object)]
pub struct MemnoterCore { core: Arc<memnoter_core::Core> }

#[uniffi::export]
impl MemnoterCore {
    #[uniffi::constructor]
    pub fn open(data_dir: String) -> Result<Arc<Self>, MemnoterError> {
        Ok(Arc::new(Self { core: Arc::new(memnoter_core::Core::open(data_dir)?) }))
    }
    pub fn dispatch(&self, command: String, args_json: String) -> Result<String, MemnoterError> {
        memnoter_core::dispatch(&self.core, &command, &args_json).map_err(Into::into)
    }
    /// A synchronous launch-time check; the host owns the background executor.
    pub fn daily_backup(&self) -> Result<(), MemnoterError> {
        memnoter_core::backups::spawn_daily_backup(self.core.clone()).join()
            .map_err(|_| MemnoterError::Storage { message: "Backup worker panicked".into() })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ffi_round_trip_and_errors_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_owned();
        let core = MemnoterCore::open(path.clone()).unwrap();
        let created = core.dispatch("create_module".into(), r#"{"name":"日本語 \"Notes\""}"#.into()).unwrap();
        assert!(core.dispatch("missing".into(), "{}".into()).unwrap_err().to_string().contains("Unknown command"));
        assert!(core.dispatch("rename_module".into(), "{}".into()).is_err());
        drop(core);
        let reopened = MemnoterCore::open(path).unwrap();
        let modules: serde_json::Value = serde_json::from_str(&reopened.dispatch("modules".into(), "{}".into()).unwrap()).unwrap();
        let module: serde_json::Value = serde_json::from_str(&created).unwrap();
        assert_eq!(modules[0]["id"], module);
        assert_eq!(modules[0]["name"], "日本語 \"Notes\"");
    }
}
