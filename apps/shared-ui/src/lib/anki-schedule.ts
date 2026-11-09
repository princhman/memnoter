import { CardState, getScheduler, scheduleReview, type Grade, type ReviewedCard, type ReviewLog, type StoredCard } from "./fsrs.ts";
import type { CardMapping } from "./anki-import.ts";

export type ImportedHistory = { card_id: string; card: ReviewedCard; logs: ReviewLog[]; fsrs_model: string };

export async function ankiHistory({ cardId, anki }: CardMapping): Promise<ImportedHistory | null> {
  if (anki.suspended) return null;
  if (anki.reviews.length) {
    const scheduler = await getScheduler();
    let current: StoredCard = {
      id: cardId, moduleId: "", moduleName: "", section: [], kind: "basic", front: [], back: [],
      dueAt: anki.reviews[0].time, stability: 0, stabilityFast: 0, difficulty: 0, scheduledDays: 0,
      learningStep: 0, state: CardState.New, scheduleStatus: "new", lastReviewAt: null,
      reps: 0, lapses: 0, fsrsModel: null,
    };
    const logs: ReviewLog[] = [];
    for (const review of [...anki.reviews].sort((a, b) => a.time - b.time)) {
      if (![1, 2, 3, 4].includes(review.rating)) continue;
      const result = scheduleReview(scheduler, current, review.rating as Grade, review.time);
      current = { ...current, ...result.card };
      logs.push(result.log);
    }
    if (!logs.length) return null;
    return { card_id: cardId, card: current, logs, fsrs_model: "fsrs-7" };
  }
  if (!["review", "relearning"].includes(anki.kind) || !anki.due || anki.intervalDays <= 0) return null;
  // Anki's SM-2 fallback at retention .9 gives stability == interval.
  // Use its FSRS-6 ease conversion for difficulty, and ts-fsrs's FSRS-7
  // fast-stability convention; real logs above always take precedence.
  const stability = anki.intervalDays;
  const difficulty = Math.max(1, Math.min(10, 11 - (anki.ease - 1) / (Math.exp(1.8722) * stability ** -0.1666 * Math.expm1(0.1 * 0.796))));
  return { card_id: cardId, fsrs_model: "fsrs-7", logs: [], card: {
    dueAt: anki.due, stability, stabilityFast: 0.8 * stability, difficulty,
    scheduledDays: stability, learningStep: 0, state: CardState.Review, scheduleStatus: "review",
    lastReviewAt: anki.due - stability * 86400000, reps: anki.reps, lapses: anki.lapses,
  } };
}
