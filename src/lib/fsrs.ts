import {
  DefaultScheduler,
  Rating,
  type DefaultSchedulerCard,
  type DefaultSchedulerCardInput,
  type DefaultSchedulerRevlog,
} from "ts-fsrs";
import type { CardKind, Segment } from "./cards";

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
  kind: CardKind;
  front: Segment[];
  back: Segment[];
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
      fsrsModel: scheduler.schedulerDefinition.model.name,
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

// Cards rated again come back in the same session once due. When nothing is
// due yet, a card due within this window is shown early instead of waiting.
export const LEARN_AHEAD_MS = 20 * MINUTE;

export function nextInQueue<T extends { dueAt: number }>(queue: readonly T[], now: number) {
  let next: T | undefined;
  for (const card of queue) {
    if (card.dueAt <= now + LEARN_AHEAD_MS && (!next || card.dueAt < next.dueAt)) next = card;
  }
  return next;
}
