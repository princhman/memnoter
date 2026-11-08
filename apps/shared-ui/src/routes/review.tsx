import { useEffect, useRef } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFace } from "@/components/card-face";
import { flushCardSyncs } from "@/lib/card-sync";
import { formatInterval, GRADES } from "@/lib/fsrs";
import { cn } from "@/lib/utils";
import { listen } from "../lib/backend.ts";
import { blockIdOf } from "@/lib/cards";
import { requestCardReveal } from "@/lib/card-reveal";
import { setNativeEditorHistory } from "@/lib/native-history";
import { reviewActionsStore } from "@/lib/review-actions";
import { useReviewSession } from "@/lib/use-review-session";
import { GRADE_STYLES } from "@/lib/review-palette";

type ReviewSearch = { module?: string };

export const Route = createFileRoute("/review")({
  beforeLoad: () => flushCardSyncs(),
  validateSearch: (search: Record<string, unknown>): ReviewSearch =>
    typeof search.module === "string" ? { module: search.module } : {},
  component: Review,
});

// Fields, such as the command palette's search, keep their own undo.
function isTypingInField() {
  return !!(document.activeElement as HTMLElement | null)?.closest?.(
    "input, textarea, [contenteditable='true']",
  );
}

const REVIEW_BUTTON =
  "group relative flex h-12 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring";

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
  const { session, queue, card, now, revealed, reviewed, error, unindexed, preview,
    nextDueAt, canShowNow, counts, currentKind, canUndo, canRedo } = useReviewSession(moduleId);
  const { reveal, rate, undo, redo, showNow } = session;
  const source = card ? [...(moduleId ? [] : [card.moduleName || "Untitled module"]), ...card.section] : [];

  const actions = useRef({ undo, redo });
  actions.current = { undo, redo };
  useEffect(() => {
    reviewActionsStore.setState(() => ({
      counts,
      current: currentKind,
      canUndo,
      canRedo,
      undo: () => void undo(),
      redo: () => void redo(),
      edit: card
        ? () => {
            requestCardReveal({ moduleId: card.moduleId, blockId: blockIdOf(card.id) });
            void router.navigate({ to: "/$moduleId", params: { moduleId: card.moduleId } });
          }
        : null,
    }));
  }, [counts, currentKind, canUndo, canRedo, undo, redo, card, router]);
  useEffect(() => () => reviewActionsStore.setState(() => null), []);

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
        if (!card && canShowNow) showNow();
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
  }, [reveal, rate, revealed, card, nextDueAt, canShowNow, showNow]);


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
            <Button variant="secondary" className="mt-2" disabled={!canShowNow} onClick={() => showNow()}>
              Show now
              <kbd className="font-sans text-xs text-muted-foreground">Space</kbd>
            </Button>
          </div>
        )}
        {queue !== null && !card && nextDueAt === null && (
          <div className="grid justify-items-center gap-3 text-center">
            <CheckCircle2 className="size-10 text-emerald-800 dark:text-emerald-400" />
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
                  <span className="font-normal tabular-nums">
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
