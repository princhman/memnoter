use super::*;
use memnoter_core::cards::*;
#[tauri::command(async)]
pub(crate) fn sync_cards(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
    cards: Vec<CardContent>,
) -> CommandResult<Vec<String>> {
    memnoter_core::cards::sync_cards(&core.db, module_id, cards)
}
#[tauri::command(async)]
pub(crate) fn due_cards(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: Option<String>,
    now: i64,
) -> CommandResult<Vec<Card>> {
    memnoter_core::cards::due_cards(&core.db, module_id, now)
}
#[tauri::command(async)]
pub(crate) fn card_schedules(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    module_id: String,
) -> CommandResult<Vec<CardSchedule>> {
    memnoter_core::cards::card_schedules(&core.db, module_id)
}
#[tauri::command(async)]
pub(crate) fn due_counts(
    core: tauri::State<'_, std::sync::Arc<Core>>,
    now: i64,
    day_end: i64,
) -> CommandResult<Vec<DueCount>> {
    memnoter_core::cards::due_counts(&core.db, now, day_end)
}
#[tauri::command(async)]
pub(crate) fn review_card(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    card_id: String,
    expected_reps: i64,
    card: ReviewedCard,
    log: ReviewLog,
) -> CommandResult<()> {
    memnoter_core::cards::review_card(&core.db, card_id, expected_reps, card, log)?;
    let _ = app.emit("sync-outbox", ());
    Ok(())
}
#[tauri::command(async)]
pub(crate) fn undo_review(
    app: tauri::AppHandle,
    core: tauri::State<'_, std::sync::Arc<Core>>,
    card_id: String,
    expected_reps: i64,
    previous: ReviewedCard,
    previous_fsrs_model: Option<String>,
    review_time: i64,
) -> CommandResult<()> {
    memnoter_core::cards::undo_review(
        &core.db,
        card_id,
        expected_reps,
        previous,
        previous_fsrs_model,
        review_time,
    )?;
    let _ = app.emit("sync-outbox", ());
    Ok(())
}
#[tauri::command(async)]
pub(crate) fn unindexed_card_modules(
    core: tauri::State<'_, std::sync::Arc<Core>>,
) -> CommandResult<Vec<UnindexedModule>> {
    memnoter_core::cards::unindexed_card_modules(&core.db)
}
