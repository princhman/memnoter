//! The same command payloads used by Tauri invoke, without a Tauri runtime.
use crate::cards::{CardContent, ReviewLog, ReviewedCard};
use crate::sync::RemoteEntry;
use crate::{Core, CoreError, ImportImage};

// Derive the accepted command inventory and dispatcher from the same entries.
macro_rules! commands {
    ($core:ident; $( $name:ident ( $( $arg:ident : $ty:ty ),* ) => $call:expr; )*) => {
        pub const DATA_COMMANDS: &[&str] = &[$(stringify!($name)),*];
        /// Accept frontend invoke arguments (camelCase), return serialized command output.
        /// Storage errors are forwarded verbatim. Unit results serialize as `null`.
        pub fn dispatch($core: &Core, command: &str, args_json: &str) -> std::result::Result<String, CoreError> {
            match command {
                $(stringify!($name) => {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    let Args { $( $arg ),* } = serde_json::from_str::<Args>(args_json).map_err(|e| CoreError::Storage(e.to_string()))?;
                    let result = $call?;
                    serde_json::to_string(&result).map_err(|e| CoreError::Storage(e.to_string()))
                },)*
                _ => Err(CoreError::Storage(format!("Unknown command: {command}"))),
            }
        }
    }
}
commands! { core;
    set_module_numbering(module_id: String, enabled: bool) => crate::set_module_numbering(&core.db, module_id, enabled);
    import_module(name: String, bytes: Vec<u8>, images: Vec<ImportImage>) => crate::import_module(core.data_dir(), &core.db, name, bytes, images);
    create_module(name: String) => crate::create_module(&core.db, name);
    modules() => crate::modules(&core.db);
    rename_module(module_id: String, name: String) => crate::rename_module(&core.db, module_id, name);
    delete_module(module_id: String) => crate::delete_module(core.data_dir(), &core.db, module_id);
    get_content(module_id: String) => crate::get_content(&core.db, module_id);
    add_update(module_id: String, bytes: Vec<u8>) => crate::add_update(&core.db, module_id, bytes);
    save_compaction(module_id: String, new_state: Vec<u8>, update_id: i64) => crate::save_compaction(&core.db, module_id, new_state, update_id);
    save_file(module_id: String, bytes: Vec<u8>, mime_type: String) => crate::save_file(core.data_dir(), &core.db, module_id, bytes, mime_type);
    read_file(module_id: String, file_id: String) => crate::read_file(core.data_dir(), &core.db, module_id, file_id);
    resolve_card_image(file_id: String) => crate::resolve_card_image(core.data_dir(), &core.db, file_id);
    cleanup_files(module_id: String, file_ids: Vec<String>, expected_state: Vec<u8>, expected_update_id: i64) => crate::cleanup_files(core.data_dir(), &core.db, module_id, file_ids, expected_state, expected_update_id);
    index_note(module_id: String, body: String, math: String, version: i64, backfill: bool) => crate::index_note(&core.db, module_id, body, math, version, backfill);
    unindexed_modules(version: i64) => crate::unindexed_modules(&core.db, version);
    search_notes(query: String, limit: i64) => crate::search_notes(&core.db, query, limit);
    sync_cards(module_id: String, cards: Vec<CardContent>) => crate::cards::sync_cards(&core.db, module_id, cards);
    due_cards(module_id: Option<String>, now: i64, created_at_cutoff: Option<i64>) => crate::cards::due_cards(&core.db, module_id, now, created_at_cutoff);
    card_schedules(module_id: String) => crate::cards::card_schedules(&core.db, module_id);
    due_counts(now: i64, day_end: i64, created_at_cutoff: Option<i64>) => crate::cards::due_counts(&core.db, now, day_end, created_at_cutoff);
    review_card(card_id: String, expected_reps: i64, card: ReviewedCard, log: ReviewLog) => crate::cards::review_card(&core.db, card_id, expected_reps, card, log);
    undo_review(card_id: String, expected_reps: i64, previous: ReviewedCard, previous_fsrs_model: Option<String>, review_time: i64) => crate::cards::undo_review(&core.db, card_id, expected_reps, previous, previous_fsrs_model, review_time);
    unindexed_card_modules() => crate::cards::unindexed_card_modules(&core.db);
    list_backups() => crate::backups::list_backups(core.data_dir());
    backup_now() => crate::backups::backup_now(core.data_dir(), &core.db);
    restore_backup(id: String) => crate::backups::restore_backup(core.data_dir(), &core.db, id);

    sync_status() => crate::sync::sync_status(&core.db);
    sync_enable(account: String) => crate::sync::sync_enable(&core.db, account);
    sync_disable() => crate::sync::sync_disable(&core.db);
    sync_outbox(limit_bytes: i64, generation: String) => crate::sync::sync_outbox(&core.db, limit_bytes, generation);
    sync_ack(max_id: i64, generation: String) => crate::sync::sync_ack(&core.db, max_id, generation);
    sync_set_cursor(cursor: i64, generation: String) => crate::sync::sync_set_cursor(&core.db, cursor, generation);
    sync_apply(entries: Vec<RemoteEntry>, cursor: i64, generation: String) => crate::sync::sync_apply(core.data_dir(), &core.db, entries, cursor, generation);
    sync_snapshot(doc: String, generation: String) => crate::sync::sync_snapshot(&core.db, doc, generation);
    sync_missing_files(generation: String) => crate::sync::sync_missing_files(&core.db, generation);
    sync_pending_deletes(generation: String) => crate::sync::sync_pending_deletes(&core.db, generation);
    sync_file_gone(file_id: String, generation: String) => crate::sync::sync_file_gone(&core.db, file_id, generation);
    sync_delete_done(file_id: String, generation: String) => crate::sync::sync_delete_done(&core.db, file_id, generation);
    sync_pending_uploads(generation: String) => crate::sync::sync_pending_uploads(&core.db, generation);
    sync_upload_done(file_id: String, generation: String) => crate::sync::sync_upload_done(&core.db, file_id, generation);
    sync_store_file(file_id: String, module_id: String, file_type: String, bytes: Vec<u8>, generation: String) => crate::sync::sync_store_file(core.data_dir(), &core.db, file_id, module_id, file_type, bytes, generation);
    sync_reconcile(generation: String) => crate::sync::sync_reconcile(core.data_dir(), &core.db, generation);
}
