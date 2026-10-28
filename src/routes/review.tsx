import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useCanGoBack, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFace } from "@/components/card-face";
import { dueCountsKey, flushCardSyncs } from "@/lib/card-sync";
import {
  formatInterval,
  getScheduler,
  GRADES,
  LEARN_AHEAD_MS,
  nextInQueue,
  previewDue,
  scheduleReview,
  type Grade,
  type Scheduler,
  type StoredCard,
} from "@/lib/fsrs";
import { cn } from "@/lib/utils";

type ReviewSearch = { module?: string };

export const Route = createFileRoute("/review")({
  beforeLoad: () => flushCardSyncs(),
  validateSearch: (search: Record<string, unknown>): ReviewSearch =>
    typeof search.module === "string" ? { module: search.module } : {},
  component: Review,
});

const GRADE_STYLES: Record<Grade, string> = {
  1: "text-destructive",
  2: "text-amber-600 dark:text-amber-400",
  3: "text-emerald-600 dark:text-emerald-400",
  4: "text-sky-600 dark:text-sky-400",
};

function Review() {
  const { module: moduleId } = Route.useSearch();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const queryClient = useQueryClient();

  const [unindexed, setUnindexed] = useState<{ id: string; name: string }[]>([]);
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  // The session's cards, loaded once: syncs made meanwhile do not reshuffle it.
  const [queue, setQueue] = useState<StoredCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [reviewed, setReviewed] = useState(0);
  const pending = useRef(false);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    setQueue(null);
    setError(null);
    setRevealed(false);
    setReviewed(0);
    Promise.all([
      getScheduler(),
      invoke<{ id: string; name: string }[]>("unindexed_card_modules"),
      flushCardSyncs().then(() =>
        invoke<StoredCard[]>("due_cards", { moduleId: moduleId ?? null, now: Date.now() }),
      ),
    ])
      .then(([scheduler, unindexed, cards]) => {
        if (cancelled) return;
        setScheduler(() => scheduler);
        setQueue(cards);
        setUnindexed(unindexed.filter((note) => !moduleId || note.id === moduleId));
      })
      .catch((error) => !cancelled && setError(String(error)));
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  const card = queue ? nextInQueue(queue, now) : undefined;

  useEffect(() => {
    shownAt.current = Date.now();
  }, [card?.id, card?.reps]);

  const preview = useMemo(
    () => (scheduler && card && revealed ? previewDue(scheduler, card, now) : null),
    [scheduler, card, revealed, now],
  );

  const close = useCallback(() => {
    if (canGoBack) router.history.back();
    else if (moduleId) void router.navigate({ to: "/$moduleId", params: { moduleId } });
    else void router.navigate({ to: "/" });
  }, [canGoBack, moduleId, router]);

  const reveal = useCallback(() => {
    if (!card) return;
    setNow(Date.now());
    setRevealed(true);
  }, [card]);

  const rate = useCallback(
    async (rating: Grade) => {
      if (!scheduler || !card || !revealed || pending.current) return;
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
        await invoke("review_card", {
          cardId: card.id,
          expectedReps: card.reps,
          card: result.card,
          log: result.log,
        });
        setError(null);
        setReviewed((count) => count + 1);
        setQueue((queue) => {
          const rest = (queue ?? []).filter((queued) => queued.id !== card.id);
          // Learning steps come back in this session; the rest are done.
          return result.card.dueAt <= reviewTime + LEARN_AHEAD_MS
            ? [...rest, { ...card, ...result.card }]
            : rest;
        });
      } catch (error) {
        // Keep the card available to retry after a transient storage failure.
        setError(String(error));
      } finally {
        pending.current = false;
        setRevealed(false);
        setNow(Date.now());
        void queryClient.invalidateQueries({ queryKey: dueCountsKey });
      }
    },
    [scheduler, card, revealed, queryClient],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      // A focused button handles Space and Enter itself.
      const onButton = (event.target as HTMLElement | null)?.closest("button");
      if ((event.key === " " || event.key === "Enter") && !onButton) {
        event.preventDefault();
        if (!revealed) reveal();
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
  }, [close, reveal, rate, revealed]);

  const remaining = queue?.length ?? 0;
  const scope = moduleId ? (card?.moduleName ?? queue?.[0]?.moduleName) : "All modules";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-3 pr-3 pl-22 text-sm text-muted-foreground"
      >
        <span data-tauri-drag-region className="truncate">
          Review{scope ? ` · ${scope}` : ""}
        </span>
        {queue && remaining > 0 && (
          <span data-tauri-drag-region className="tabular-nums">
            {remaining} left
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Close review (Esc)"
          onClick={close}
        >
          <X />
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8">
        <div className="flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 py-8">
          {unindexed.length > 0 && (
            <section className="rounded-lg border p-4 text-sm" aria-label="Notes awaiting card indexing">
              <p>Review is incomplete: {unindexed.length} {unindexed.length === 1 ? "note has" : "notes have"} not been checked for cards. Open each note below to include its cards, then return to review.</p>
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
          {queue !== null && !card && (
            <div className="grid justify-items-center gap-3 text-center">
              <CheckCircle2 className="size-10 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-2xl font-semibold">{unindexed.length ? "No due cards in checked notes" : "All caught up"}</h1>
              <p className="text-muted-foreground">
                {reviewed > 0
                  ? `You reviewed ${reviewed} ${reviewed === 1 ? "card" : "cards"}.`
                  : "No cards are due right now."}
              </p>
              <Button variant="outline" className="mt-2" onClick={close}>
                Back to notes
              </Button>
            </div>
          )}
          {card && (
            <>
              {!moduleId && (
                <p className="text-center text-xs tracking-wide text-muted-foreground uppercase">
                  {card.moduleName}
                </p>
              )}
              <CardFace
                key={card.id}
                kind={card.kind}
                front={card.front}
                back={card.back}
                revealed={revealed}
              />
            </>
          )}
        </div>

        {card && (
          <div className="flex w-full max-w-2xl justify-center gap-2">
            {!revealed ? (
              <Button size="lg" className="min-w-48" onClick={reveal}>
                Show answer
                <kbd className="ml-1 text-xs opacity-70">Space</kbd>
              </Button>
            ) : (
              GRADES.map(({ rating, label, key }) => (
                <Button
                  key={rating}
                  variant="outline"
                  className="h-auto min-w-24 flex-col gap-0.5 py-2"
                  onClick={() => void rate(rating)}
                >
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {preview ? formatInterval(preview[rating] - now) : ""}
                  </span>
                  <span className={cn("font-medium", GRADE_STYLES[rating])}>{label}</span>
                  <kbd className="text-[0.65rem] text-muted-foreground">{key}</kbd>
                </Button>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
