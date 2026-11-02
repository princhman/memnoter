import { useSelector } from "@tanstack/react-store";
import { appStore } from "@/lib/store";
import { writeCards } from "@/lib/card-writes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFace } from "@/components/card-face";
import { dueCountsKey, endOfDay, flushCardSyncs } from "@/lib/card-sync";
import { backfillCards } from "@/lib/card-backfill";
import {
  formatInterval,
  getScheduler,
  GRADES,
  nextInQueue,
  previewDue,
  scheduleReview,
  type Grade,
  type Scheduler,
  type StoredCard,
} from "@/lib/fsrs";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import { blockIdOf } from "@/lib/cards";
import { requestCardReveal } from "@/lib/card-reveal";
import { setNativeEditorHistory } from "@/lib/native-history";
import { reviewActionsStore } from "@/lib/review-actions";

type ReviewSearch = { module?: string };

export const Route = createFileRoute("/review")({
  beforeLoad: () => flushCardSyncs(),
  validateSearch: (search: Record<string, unknown>): ReviewSearch =>
    typeof search.module === "string" ? { module: search.module } : {},
  component: Review,
});

// A grade made this session, kept so it can be taken back and redone.
type GradeStep = {
  before: StoredCard;
  result: ReturnType<typeof scheduleReview>;
  queueBefore: StoredCard[];
  queueAfter: StoredCard[];
};

// A card's scheduling state, as review_card and undo_review take it.
function reviewedFields(card: StoredCard) {
  const { dueAt, stability, stabilityFast, difficulty, scheduledDays, learningStep,
    state, scheduleStatus, lastReviewAt, reps, lapses } = card;
  return { dueAt, stability, stabilityFast, difficulty, scheduledDays, learningStep,
    state, scheduleStatus, lastReviewAt, reps, lapses };
}

// The session's remaining cards, split like the due counts: due now, and
// due later today.
function countByState(queue: StoredCard[], now: number) {
  const counts = { new: 0, learning: 0, review: 0, laterToday: { new: 0, learning: 0, review: 0 } };
  for (const { state, dueAt } of queue) {
    const split = dueAt <= now ? counts : counts.laterToday;
    // FSRS states: 0 new, 1 learning, 2 review, 3 relearning.
    if (state === 0) split.new++;
    else if (state === 2) split.review++;
    else split.learning++;
  }
  return counts;
}

// Fields, such as the command palette's search, keep their own undo.
function isTypingInField() {
  return !!(document.activeElement as HTMLElement | null)?.closest?.(
    "input, textarea, [contenteditable='true']",
  );
}

// A soft tint of each grade's colour, deepening on hover.
const GRADE_STYLES: Record<Grade, string> = {
  1: "bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400",
  2: "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400",
  3: "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400",
  4: "bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-400",
};

const REVIEW_BUTTON =
  "group relative flex h-12 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

// The key that presses a button, shown inside its top-right corner on hover or focus.
function KeyHint({ children }: { children: string }) {
  return (
    <kbd className="pointer-events-none absolute top-1 right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded bg-foreground/5 px-1 font-sans text-[0.55rem] leading-none text-current opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      {children}
    </kbd>
  );
}

function Review() {
  const { module: moduleId } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [unindexed, setUnindexed] = useState<{ id: string; name: string }[]>([]);
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  // The session's cards, loaded once: syncs made meanwhile do not reshuffle it.
  const [queue, setQueue] = useState<StoredCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [reviewed, setReviewed] = useState(0);
  const [undoSteps, setUndoSteps] = useState<GradeStep[]>([]);
  const [redoSteps, setRedoSteps] = useState<GradeStep[]>([]);
  const pending = useRef(false);
  const shownAt = useRef(Date.now());
  const displayedCard = useRef<StoredCard | undefined>(undefined);
  const scopeLoading = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Keep the mounted card while changing scope so shared cards do not flash.
    const previousCard = displayedCard.current;
    scopeLoading.current = true;
    setError(null);
    setReviewed(0);
    setEarlyUntil(null);
    setUndoSteps([]);
    setRedoSteps([]);
    Promise.all([
      getScheduler(),
      // Notes never checked for cards are checked first, in the background.
      backfillCards().then(() =>
        Promise.all([
          invoke<{ id: string; name: string }[]>("unindexed_card_modules"),
          flushCardSyncs().then(() =>
            // Cards due later today join the session, to be shown once due.
            invoke<StoredCard[]>("due_cards", { moduleId: moduleId ?? null, now: endOfDay(Date.now()) }),
          ),
        ]),
      ),
    ])
      .then(([scheduler, [unindexed, cards]]) => {
        if (cancelled) return;
        const nextCard = nextInQueue(cards, Date.now(), appStore.state.learnAhead);
        if (nextCard?.id !== previousCard?.id || nextCard?.reps !== previousCard?.reps) {
          setRevealed(false);
          setNow(Date.now());
        }
        setScheduler(() => scheduler);
        setQueue(cards);
        setUnindexed(unindexed.filter((note) => !moduleId || note.id === moduleId));
      })
      .catch((error) => !cancelled && setError(String(error)))
      .finally(() => { if (!cancelled) scopeLoading.current = false; });
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  const learnAhead = useSelector(appStore, (state) => state.learnAhead);
  // Set by "Show now": cards due by then may be shown early, until a grade.
  const [earlyUntil, setEarlyUntil] = useState<number | null>(null);
  const card = queue
    ? nextInQueue(queue, now, learnAhead) ?? (earlyUntil === null ? undefined : nextInQueue(queue, earlyUntil))
    : undefined;
  // The card due next after now, if the session has one.
  const nextDueAt = queue?.reduce<number | null>(
    (soonest, { dueAt }) => (dueAt > now && (soonest === null || dueAt < soonest) ? dueAt : soonest),
    null,
  ) ?? null;
  // Shows that card, and moves it into the due counts, once it is due. While
  // waiting for it, the countdown on the page also refreshes.
  useEffect(() => {
    if (nextDueAt === null) return;
    const delay = Math.min(nextDueAt - Date.now() + 50, card ? 2 ** 31 - 1 : 30_000);
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(delay, 0));
    return () => window.clearTimeout(timeout);
  }, [nextDueAt, now, card]);
  // The module is in the breadcrumb unless every module is under review.
  const source = card ? [...(moduleId ? [] : [card.moduleName || "Untitled module"]), ...card.section] : [];
  displayedCard.current = card;

  useEffect(() => {
    shownAt.current = Date.now();
  }, [card?.id, card?.reps]);

  const preview = useMemo(
    () => (scheduler && card && revealed ? previewDue(scheduler, card, now) : null),
    [scheduler, card, revealed, now],
  );

  const reveal = useCallback(() => {
    if (!card) return;
    setNow(Date.now());
    setRevealed(true);
  }, [card]);

  const rate = useCallback(
    async (rating: Grade) => {
      if (!scheduler || !card || !revealed || pending.current || scopeLoading.current) return;
      pending.current = true;
      const reviewTime = Date.now();
      try {
        const result = scheduleReview(
          scheduler,
          card,
          rating,
          reviewTime,
          reviewTime - shownAt.current,
        );
        await writeCards("review_card", {
          cardId: card.id,
          expectedReps: card.reps,
          card: result.card,
          log: result.log,
        });
        const queueBefore = queue ?? [];
        const rest = queueBefore.filter((queued) => queued.id !== card.id);
        // A card due again today comes back in this session once due.
        const queueAfter = result.card.dueAt < endOfDay(reviewTime)
          ? [...rest, { ...card, ...result.card }]
          : rest;
        setError(null);
        setReviewed((count) => count + 1);
        setQueue(queueAfter);
        setUndoSteps((steps) => [...steps, { before: card, result, queueBefore, queueAfter }]);
        setRedoSteps([]);
      } catch (error) {
        // Keep the card available to retry after a transient storage failure.
        setError(String(error));
      } finally {
        pending.current = false;
        setRevealed(false);
        setNow(Date.now());
        setEarlyUntil(null);
        void queryClient.invalidateQueries({ queryKey: dueCountsKey });
      }
    },
    [scheduler, card, revealed, queue, queryClient],
  );

  // Takes back the last grade: the card returns to its state before it, and
  // to the queue, to be graded again.
  const undo = useCallback(async () => {
    const step = undoSteps[undoSteps.length - 1];
    if (!step || pending.current || scopeLoading.current) return;
    pending.current = true;
    try {
      await writeCards("undo_review", {
        cardId: step.before.id,
        expectedReps: step.result.card.reps,
        previous: reviewedFields(step.before),
        previousFsrsModel: step.before.fsrsModel,
        reviewTime: step.result.log.reviewTime,
      });
      setError(null);
      setUndoSteps((steps) => steps.slice(0, -1));
      setRedoSteps((steps) => [...steps, step]);
      setQueue(step.queueBefore);
      setReviewed((count) => count - 1);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setRevealed(false);
      setNow(Date.now());
      setEarlyUntil(null);
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
    }
  }, [undoSteps, queryClient]);

  // Grades the card again as it was graded before the undo.
  const redo = useCallback(async () => {
    const step = redoSteps[redoSteps.length - 1];
    if (!step || pending.current || scopeLoading.current) return;
    pending.current = true;
    try {
      await writeCards("review_card", {
        cardId: step.before.id,
        expectedReps: step.before.reps,
        card: step.result.card,
        log: step.result.log,
      });
      setError(null);
      setRedoSteps((steps) => steps.slice(0, -1));
      setUndoSteps((steps) => [...steps, step]);
      setQueue(step.queueAfter);
      setReviewed((count) => count + 1);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setRevealed(false);
      setNow(Date.now());
      setEarlyUntil(null);
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
    }
  }, [redoSteps, queryClient]);

  // The toolbar's undo, redo and edit buttons act on this review.
  const actions = useRef({ undo, redo });
  actions.current = { undo, redo };
  useEffect(() => {
    reviewActionsStore.setState(() => ({
      counts: queue ? countByState(queue, now) : null,
      canUndo: undoSteps.length > 0,
      canRedo: redoSteps.length > 0,
      undo: () => void undo(),
      redo: () => void redo(),
      edit: card
        ? () => {
            requestCardReveal({ moduleId: card.moduleId, blockId: blockIdOf(card.id) });
            void router.navigate({ to: "/$moduleId", params: { moduleId: card.moduleId } });
          }
        : null,
    }));
  }, [undoSteps.length, redoSteps.length, undo, redo, card, router, queue, now]);
  useEffect(() => () => reviewActionsStore.setState(() => null), []);

  // The app menu's Undo and Redo, and ⌘Z and ⌘⇧Z, act on grades here.
  useEffect(() => {
    const update = () => setNativeEditorHistory(!isTypingInField());
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    let disposed = false;
    const unlisten = listen<string>("menu", ({ payload }) => {
      if (disposed || isTypingInField()) return;
      if (payload === "editor-undo") void actions.current.undo();
      if (payload === "editor-redo") void actions.current.redo();
    });
    return () => {
      disposed = true;
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      setNativeEditorHistory(false);
      void unlisten.then((stop) => stop()).catch(console.error);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      // Typing in the command palette or another field is not reviewing.
      if (target?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      // A focused button handles Space and Enter itself.
      const onButton = target?.closest("button");
      if ((event.key === " " || event.key === "Enter") && !onButton) {
        event.preventDefault();
        if (!card && nextDueAt !== null) setEarlyUntil(nextDueAt);
        else if (!revealed) reveal();
        return;
      }
      const grade = GRADES.find(({ key }) => key === event.key);
      if (grade && revealed) {
        event.preventDefault();
        void rate(grade.rating);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reveal, rate, revealed, card, nextDueAt]);


  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-5 pb-2 pt-2 sm:pt-8">
      <div className="flex flex-col gap-5">
        {unindexed.length > 0 && (
          <section className="rounded-lg bg-muted/50 p-4 text-sm" aria-label="Notes awaiting card indexing">
            <p>Review is incomplete: {unindexed.length} {unindexed.length === 1 ? "note" : "notes"} could not be checked for cards. Open each note below to include its cards, then return to review.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {unindexed.map((note) => (
                <Button key={note.id} variant="outline" onClick={() => void router.navigate({ to: "/$moduleId", params: { moduleId: note.id } })}>
                  Open {note.name || "Untitled note"}
                </Button>
              ))}
            </div>
          </section>
        )}
        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}
        {queue === null && !error && (
          <p className="text-center text-muted-foreground">Loading cards…</p>
        )}
        {queue !== null && !card && nextDueAt !== null && (
          <div className="grid justify-items-center gap-3 text-center">
            <Clock className="size-10 text-muted-foreground" />
            <h1 className="text-2xl font-semibold">Next card in {formatInterval(nextDueAt - now)}</h1>
            <p className="text-muted-foreground">It shows here once it is due.</p>
            <Button variant="secondary" className="mt-2" onClick={() => setEarlyUntil(nextDueAt)}>
              Show now
              <kbd className="font-sans text-xs text-muted-foreground">Space</kbd>
            </Button>
          </div>
        )}
        {queue !== null && !card && nextDueAt === null && (
          <div className="grid justify-items-center gap-3 text-center">
            <CheckCircle2 className="size-10 text-emerald-600 dark:text-emerald-400" />
            <h1 className="text-2xl font-semibold">{unindexed.length ? "No due cards in checked notes" : "All caught up"}</h1>
            <p className="text-muted-foreground">
              {reviewed > 0
                ? `You reviewed ${reviewed} ${reviewed === 1 ? "card" : "cards"}.`
                : "No cards are due right now."}
            </p>
          </div>
        )}
        {card && (
          <section className="min-w-0 py-7 sm:py-8" aria-label="Review card">
            {/* Where the card is written. */}
            {source.length > 0 && (
              <p className="mb-8 truncate text-xs text-muted-foreground">{source.join(" / ")}</p>
            )}
            <CardFace
              // A card graded and shown again starts with its clozes hidden.
              key={`${card.id}:${card.reps}`}
              kind={card.kind}
              front={card.front}
              back={card.back}
              revealed={revealed}
            />
          </section>
        )}
      </div>

      {card && (
        <div className="mt-auto grid w-full shrink-0 grid-cols-2 gap-2 pt-6 pb-2 sm:grid-cols-4">
          {!revealed ? (
            <button
              type="button"
              className={cn(REVIEW_BUTTON, "col-span-full bg-foreground text-background hover:bg-foreground/90")}
              onClick={reveal}
            >
              Show answer
              <KeyHint>Space</KeyHint>
            </button>
          ) : (
            GRADES.map(({ rating, label, key }) => (
              <button
                key={rating}
                type="button"
                className={cn(REVIEW_BUTTON, GRADE_STYLES[rating])}
                onClick={() => void rate(rating)}
              >
                {label}
                {preview && (
                  <span className="font-normal tabular-nums opacity-70">
                    ({formatInterval(preview[rating] - now)})
                  </span>
                )}
                <KeyHint>{key}</KeyHint>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
