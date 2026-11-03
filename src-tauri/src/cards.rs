use super::*;
use memnoter_core::cards::*;
#[tauri::command(async)]
pub(crate) fn sync_cards(db: tauri::State<'_, Db>, module_id: String, cards: Vec<CardContent>) -> CommandResult<Vec<String>> {
    memnoter_core::cards::sync_cards(&db, module_id, cards)
}
#[tauri::command(async)]
pub(crate) fn due_cards(db: tauri::State<'_, Db>, module_id: Option<String>, now: i64) -> CommandResult<Vec<Card>> {
    memnoter_core::cards::due_cards(&db, module_id, now)
}
#[tauri::command(async)]
pub(crate) fn card_schedules(db: tauri::State<'_, Db>, module_id: String) -> CommandResult<Vec<CardSchedule>> {
    memnoter_core::cards::card_schedules(&db, module_id)
}
#[tauri::command(async)]
pub(crate) fn due_counts(db: tauri::State<'_, Db>, now: i64, day_end: i64) -> CommandResult<Vec<DueCount>> {
    memnoter_core::cards::due_counts(&db, now, day_end)
}
#[tauri::command(async)]
pub(crate) fn review_card(db: tauri::State<'_, Db>, card_id: String, expected_reps: i64, card: ReviewedCard, log: ReviewLog) -> CommandResult<()> {
    memnoter_core::cards::review_card(&db, card_id, expected_reps, card, log)
}
#[tauri::command(async)]
pub(crate) fn undo_review(db: tauri::State<'_, Db>, card_id: String, expected_reps: i64, previous: ReviewedCard, previous_fsrs_model: Option<String>, review_time: i64) -> CommandResult<()> {
    memnoter_core::cards::undo_review(&db, card_id, expected_reps, previous, previous_fsrs_model, review_time)
}
#[tauri::command(async)]
pub(crate) fn unindexed_card_modules(db: tauri::State<'_, Db>) -> CommandResult<Vec<UnindexedModule>> {
    memnoter_core::cards::unindexed_card_modules(&db)
}
