//! Sync secrets never enter the portable database or its backups.
use memnoter_core::{Core, CoreError};
use serde_json::{json, Value};
fn entry(core: &Core) -> Result<keyring::Entry, CoreError> {
    keyring::Entry::new("com.memnoter.sync", &core.data_dir().to_string_lossy()).map_err(error)
}
fn error(e: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(format!("Sync keyring: {e}"))
}
pub fn save(core: &Core, account: &Value) -> Result<(), CoreError> {
    if !account["key"].is_string() || !account["token"].is_string() {
        return Err(error("Missing credentials"));
    }
    entry(core)?
        .set_password(&account.to_string())
        .map_err(error)
}
pub fn load(core: &Core) -> Result<Value, CoreError> {
    match entry(core)?.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map_err(error),
        Err(keyring::Error::NoEntry) => Ok(Value::Null),
        Err(e) => Err(error(e)),
    }
}
pub fn delete(core: &Core) -> Result<(), CoreError> {
    match entry(core)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(error(e)),
    }
}
/// Runs before any backup. Persist the keyring receipt before scrubbing SQLite;
/// if either operation fails, startup fails closed and the legacy row survives.
pub fn migrate(core: &Core) -> Result<(), CoreError> {
    let status: Value = serde_json::from_str(&memnoter_core::dispatch(core, "sync_status", "{}")?)
        .map_err(error)?;
    if let Some(raw) = status["account"].as_str() {
        if let Ok(account) = serde_json::from_str::<Value>(raw) {
            if account["key"].is_string() || account["token"].is_string() {
                save(core, &account)?;
                let identity =
                    json!({"server":account["server"],"userId":account["userId"]}).to_string();
                memnoter_core::dispatch(
                    core,
                    "sync_enable",
                    &json!({"account":identity}).to_string(),
                )?;
            }
        }
    }
    Ok(())
}
