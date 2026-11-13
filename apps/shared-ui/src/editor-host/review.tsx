import { isWriteAdmitted, registerFlusher } from "../lib/write-lifecycle";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { CardFace } from "../components/card-face";
import { formatInterval, GRADES } from "../lib/fsrs";
import { postNativeEvent } from "../lib/backend";
import { useReviewSession } from "../lib/use-review-session";
import { reviewCountsLabel } from "../lib/review-palette";
import { BRIDGE_VERSION, type ReviewApi } from "./protocol";
import "../App.css";
import "./review.css";
import "./theme";
import "katex/dist/katex.min.css";

function ReviewHost() {
  const [scope, setScope] = useState<string | undefined>();
  const state = useReviewSession(scope, false);
  const { session, cutoff, card, revealed, preview, now, counts } = state;
  const scopeRef = useRef<string | null | undefined>(undefined);
  const cutoffRef = useRef(cutoff);
  cutoffRef.current = cutoff;
  useEffect(() => {
    if (scopeRef.current !== undefined) void session.load(scopeRef.current ?? undefined, cutoff);
  }, [session, cutoff]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerFlusher("live-review", async () => {
      if (session.getSnapshot().busy || session.getSnapshot().loading) {
        await new Promise<void>(resolve => {
          const stop = session.subscribe(() => {
            if (!session.getSnapshot().busy && !session.getSnapshot().loading) { stop(); resolve(); }
          });
        });
      }
      if (session.getSnapshot().error) throw new Error(session.getSnapshot().error!);
    });
  }, [session]);
  useEffect(() => {
    const api: ReviewApi = {
      load: async scope => { scopeRef.current = scope; setScope(scope ?? undefined); await session.load(scope ?? undefined, cutoffRef.current); },
      reveal: session.reveal, showNow: session.showNow,
      rate: session.rate, undo: session.undo, redo: session.redo,
    };
    if (import.meta.env.DEV) {
      for (const method of ["rate", "undo", "redo", "reveal", "showNow"] as const) {
        const action = api[method] as (...args: never[]) => unknown;
        Object.assign(api, { [method]: (...args: never[]) => isWriteAdmitted() ? action(...args) : Promise.resolve() });
      }
    }
    window.memnoterReview = api;
    postNativeEvent("ready", { protocolVersion: BRIDGE_VERSION });
  }, [session]);
  useEffect(() => {
    const empty = { new: 0, learning: 0, review: 0 };
    const label = reviewCountsLabel(counts ?? empty, state.currentKind);
    postNativeEvent('reviewState', {
      counts: counts ?? empty, laterToday: counts?.laterToday ?? empty, countsLabel: label,
      currentKind: state.currentKind, intervals: preview ? GRADES.map(({ rating }) => formatInterval(preview[rating] - now)) : [],
      canUndo: state.canUndo, canRedo: state.canRedo, revealed, busy: state.busy,
      hasCard: !!card, canShowNow: state.canShowNow, loading: state.loading, reviewed: state.reviewed,
      moduleId: card?.moduleId ?? null, cardId: card?.id ?? null, error: state.error,
    });
  }, [state, card, counts, now, preview, revealed]);
  return <main key={card ? `${card.id}:${card.reps}` : 'waiting'} className="review-scroll-container p-8">
    {state.error && <p role="alert">{state.error}</p>}
    {state.unindexed.length > 0 && <p>Review is incomplete: {state.unindexed.length} notes could not be checked for cards. Open these notes to include their cards: {state.unindexed.map(note => note.name || 'Untitled note').join(', ')}.</p>}
    {card ? <><p className="mb-8 text-xs text-muted-foreground">{[...(scope ? [] : [card.moduleName]), ...card.section].join(' / ')}</p><CardFace kind={card.kind} front={card.front} back={card.back} revealed={revealed} revealedSteps={state.revealedSteps} /></>
      : state.loading ? <p>Loading cards…</p> : state.nextDueAt !== null ? <p>Next card in {formatInterval(state.nextDueAt - now)}. It shows here once it is due.</p>
      : <><h1>All caught up</h1><p>{state.reviewed ? `You reviewed ${state.reviewed} cards.` : 'No cards are due right now.'}</p></>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<ReviewHost />);
