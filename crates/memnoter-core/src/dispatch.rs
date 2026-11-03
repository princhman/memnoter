//! The same command payloads used by Tauri invoke, without a Tauri runtime.
use crate::cards::*;
use crate::*;

// Derive the accepted command inventory and dispatcher from the same entries.
macro_rules! commands {
    ($core:ident; $( $name:ident ( $( $arg:ident : $ty:ty ),* ) => $call:expr; )*) => {
        pub const DATA_COMMANDS: &[&str] = &[$(stringify!($name)),*];
        /// Accept frontend invoke arguments (camelCase), return serialized command output.
        /// Storage errors are forwarded verbatim. Unit results serialize as `null`.
        pub fn dispatch($core: &Core, command: &str, args_json: &str) -> CommandResult<String> {
            match command {
                $(stringify!($name) => {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    let Args { $( $arg ),* } = serde_json::from_str::<Args>(args_json).map_err(db_err)?;
                    let result = $call?;
                    serde_json::to_string(&result).map_err(db_err)
                },)*
                _ => Err(format!("Unknown command: {command}")),
            }
        }
    }
}
commands! { core;
    set_module_numbering(module_id: String, enabled: bool) => crate::set_module_numbering(&core.db, module_id, enabled);
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
    due_cards(module_id: Option<String>, now: i64) => crate::cards::due_cards(&core.db, module_id, now);
    card_schedules(module_id: String) => crate::cards::card_schedules(&core.db, module_id);
    due_counts(now: i64, day_end: i64) => crate::cards::due_counts(&core.db, now, day_end);
    review_card(card_id: String, expected_reps: i64, card: ReviewedCard, log: ReviewLog) => crate::cards::review_card(&core.db, card_id, expected_reps, card, log);
    undo_review(card_id: String, expected_reps: i64, previous: ReviewedCard, previous_fsrs_model: Option<String>, review_time: i64) => crate::cards::undo_review(&core.db, card_id, expected_reps, previous, previous_fsrs_model, review_time);
    unindexed_card_modules() => crate::cards::unindexed_card_modules(&core.db);
    list_backups() => crate::backups::list_backups(core.data_dir());
    backup_now() => crate::backups::backup_now(core.data_dir(), &core.db);
    restore_backup(id: String) => crate::backups::restore_backup(core.data_dir(), &core.db, id);
}
