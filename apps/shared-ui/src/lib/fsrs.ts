import {
  DefaultScheduler,
  Rating,
  type DefaultSchedulerCard,
  type DefaultSchedulerCardInput,
  type DefaultSchedulerRevlog,
} from "ts-fsrs";
import type { CardKind, CardPayload } from "./cards";

// Scheduling runs here with ts-fsrs; Rust only stores the results. The
// library's default parameters for FSRS-7, with no settings yet.
export const FSRS_VERSION = "FSRS-7";

export type Scheduler = DefaultScheduler<"FSRS-7">;

let scheduler: Promise<Scheduler> | undefined;

export function getScheduler() {
  scheduler ??= DefaultScheduler({ version: FSRS_VERSION });
  return scheduler;
}

export const GRADES = [
  { rating: Rating.Again, label: "Again", key: "1" },
  { rating: Rating.Hard, label: "Hard", key: "2" },
  { rating: Rating.Good, label: "Good", key: "3" },
  { rating: Rating.Easy, label: "Easy", key: "4" },
] as const;

export type Grade = (typeof GRADES)[number]["rating"];

// FSRS fields as stored: times are epoch milliseconds.
export type FsrsFields = {
  dueAt: number;
  stability: number;
  stabilityFast: number;
  difficulty: number;
  scheduledDays: number;
  learningStep: number;
  state: number;
  scheduleStatus: string;
  lastReviewAt: number | null;
};

// A due card from `due_cards`.
export type StoredCard = FsrsFields & {
  id: string;
  moduleId: string;
  moduleName: string;
  // Earliest review time imposed by the sibling, independent of FSRS.
  availableAt?: number;
  // Titles of the headings the card sits under, outermost first.
  section: string[];
  kind: CardKind;
  front: CardPayload;
  back: CardPayload;
  reps: number;
  lapses: number;
  fsrsModel: string | null;
};

export type ReviewedCard = FsrsFields & { reps: number; lapses: number };

export type ReviewLog = FsrsFields & {
  rating: Grade;
  reviewTime: number;
  durationMs: number | null;
  fsrsModel: string;
};

function toFsrsCard(card: StoredCard): DefaultSchedulerCardInput {
  return {
    cardId: card.id,
    dueAt: new Date(card.dueAt),
    lastReviewAt: card.lastReviewAt === null ? null : new Date(card.lastReviewAt),
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    learningStep: card.learningStep,
    state: card.state as DefaultSchedulerCardInput["state"],
    scheduleStatus: card.scheduleStatus as DefaultSchedulerCardInput["scheduleStatus"],
    reps: card.reps,
    lapses: card.lapses,
  };
}

function fieldsOf(card: DefaultSchedulerCard | DefaultSchedulerRevlog): FsrsFields {
  return {
    dueAt: card.dueAt.getTime(),
    stability: card.stability,
    stabilityFast: card.stabilityFast,
    difficulty: card.difficulty,
    scheduledDays: card.scheduledDays,
    learningStep: card.learningStep,
    state: card.state,
    scheduleStatus: card.scheduleStatus,
    lastReviewAt: card.lastReviewAt?.getTime() ?? null,
  };
}

export function scheduleReview(
  scheduler: Scheduler,
  card: StoredCard,
  rating: Grade,
  now: number,
  durationMs: number | null = null,
): { card: ReviewedCard; log: ReviewLog } {
  const result = scheduler.review({
    card: toFsrsCard(card),
    grade: rating,
    now: new Date(now),
  });
  return {
    card: { ...fieldsOf(result.card), reps: result.card.reps, lapses: result.card.lapses },
    log: {
      ...fieldsOf(result.revlog),
      rating,
      reviewTime: result.revlog.reviewTime.getTime(),
      durationMs,
      fsrsModel: FSRS_VERSION.toLowerCase(),
    },
  };
}

// When each rating would bring the card back, as FSRS previews it.
export function previewDue(
  scheduler: Scheduler,
  card: StoredCard,
  now: number,
): Record<Grade, number> {
  const due = {} as Record<Grade, number>;
  for (const item of scheduler.preview({ card: toFsrsCard(card), now: new Date(now) })) {
    due[item.grade as Grade] = item.card.dueAt.getTime();
  }
  return due;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A short label for the time until a card is due, like Anki's buttons.
export function formatInterval(ms: number) {
  const round = (value: number) =>
    value < 10 ? String(Math.round(value * 10) / 10).replace(/\.0$/, "") : String(Math.round(value));
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${round(days / 30)}mo`;
  return `${round(days / 365)}y`;
}

// With learn ahead on and no card due, a card due within this window is
// shown instead of waiting for it.
export const LEARN_AHEAD_MS = 20 * MINUTE;

// Keep this window in step with REVIEW_AVAILABILITY in the Rust core.
const SIBLING_DELAY_MS = 10 * MINUTE;

type QueueCard = { dueAt: number; availableAt?: number };

export function reviewDueAt(card: QueueCard) {
  return Math.max(card.dueAt, card.availableAt ?? 0);
}

// The desktop keeps a session snapshot instead of reloading after each grade.
// Mirror the core's availability in that snapshot; undo restores queueBefore.
export function separateSibling(queue: StoredCard[], reviewed: StoredCard, reviewTime: number) {
  if (reviewed.kind !== "basic") return queue;
  const siblingId = reviewed.id.endsWith(":reverse")
    ? reviewed.id.slice(0, -8)
    : `${reviewed.id}:reverse`;
  return queue.map((card) => card.kind === "basic" && card.moduleId === reviewed.moduleId && card.id === siblingId
    ? { ...card, availableAt: reviewTime + SIBLING_DELAY_MS }
    : card);
}

// The most overdue card. Without learn ahead a card is never shown before it
// is due: one graded Again (1m) waits its minute, counted meanwhile as due
// later today.
export function nextInQueue<T extends QueueCard>(
  queue: readonly T[],
  now: number,
  learnAhead = false,
  availableNow = now,
) {
  const limit = now + (learnAhead ? LEARN_AHEAD_MS : 0);
  let next: T | undefined;
  for (const card of queue) {
    if ((card.availableAt ?? 0) <= availableNow && card.dueAt <= limit
      && (!next || reviewDueAt(card) < reviewDueAt(next))) next = card;
  }
  return next;
}
