import { endOfDay } from './day-clock';
import { siblingOf } from './card-id';
import { cardCountKind } from './card-count-kind';
import { call } from './backend';
import { writeCards } from './card-writes';
import { backfillCards } from './card-backfill';
import { dueCountsKey, flushCardSyncs } from './card-sync';
import { queryClient } from './query-client';
import { getScheduler, nextInQueue, reviewDueAt, separateSibling, previewDue, scheduleReview, type Grade, type StoredCard, type Scheduler } from './fsrs';

type GradeStep = { before: StoredCard; result: ReturnType<typeof scheduleReview>; queueBefore: StoredCard[]; queueAfter: StoredCard[] };
function reviewedFields(card: StoredCard) {
  const { dueAt, stability, stabilityFast, difficulty, scheduledDays, learningStep, state, scheduleStatus, lastReviewAt, reps, lapses } = card;
  return { dueAt, stability, stabilityFast, difficulty, scheduledDays, learningStep, state, scheduleStatus, lastReviewAt, reps, lapses };
}
function countByState(queue: StoredCard[], now: number) {
  const counts = { new: 0, learning: 0, review: 0, laterToday: { new: 0, learning: 0, review: 0 } };
  for (const card of queue) {
    const dueAt = reviewDueAt(card);
    if (dueAt > endOfDay(now)) continue;
    (dueAt <= now ? counts : counts.laterToday)[cardCountKind(card.state)]++;
  }
  return counts;
}

// Each mounted review owns one session. Writes survive scope changes, but their
// results may only update the scope that admitted them.
export class ReviewSession {
  private queue: StoredCard[] | null = null;
  private scheduler: Scheduler | null = null;
  private undoSteps: GradeStep[] = [];
  private redoSteps: GradeStep[] = [];
  private scope: string | undefined;
  private generation = 0;
  private loadGeneration = 0;
  private loadedGeneration = -1;
  private writing: Promise<unknown> = Promise.resolve();
  private pending = false;
  private loading = false;
  private revealed = false;
  private revealedSteps = 0;
  private reviewed = 0;
  private error: string | null = null;
  private unindexed: { id: string; name: string }[] = [];
  private now = Date.now();
  private shownAt = this.now;
  private learnAhead = false;
  private earlyUntil: number | null = null;
  private retained: StoredCard | undefined;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private derive() {
    const card = this.retained ?? (this.queue ? nextInQueue(this.queue, this.now, this.learnAhead)
      ?? (this.earlyUntil === null ? undefined : nextInQueue(this.queue, this.earlyUntil, false, this.now)) : undefined);
    const nextDueAt = this.queue?.reduce<number | null>((soonest, card) => {
      const dueAt = reviewDueAt(card);
      return dueAt > this.now && (soonest === null || dueAt < soonest) ? dueAt : soonest;
    }, null) ?? null;
    return {
      queue: this.queue, card, now: this.now, revealed: this.revealed, revealedSteps: this.revealedSteps, reviewed: this.reviewed,
      error: this.error, unindexed: this.unindexed, loading: this.loading, busy: this.pending,
      counts: this.queue ? countByState(this.queue, this.now) : null,
      currentKind: card ? cardCountKind(card.state) : null,
      canUndo: this.undoSteps.length > 0, canRedo: this.redoSteps.length > 0,
      preview: this.scheduler && card && this.revealed ? previewDue(this.scheduler, card, this.now) : null,
      nextDueAt, canShowNow: this.queue !== null && nextDueAt !== null && nextInQueue(this.queue, nextDueAt, false, this.now) !== undefined,
    };
  }
  private snapshot = this.derive();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.emit();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) clearTimeout(this.timer); };
  };
  private emit() {
    const previous = this.snapshot.card;
    this.snapshot = this.derive();
    if (previous?.id !== this.snapshot.card?.id || previous?.reps !== this.snapshot.card?.reps) this.shownAt = Date.now();
    for (const listener of this.listeners) listener();
    clearTimeout(this.timer);
    if (this.listeners.size && this.snapshot.nextDueAt !== null) {
      const delay = Math.min(this.snapshot.nextDueAt - Date.now() + 50, this.snapshot.card ? 2 ** 31 - 1 : 30_000);
      this.timer = setTimeout(() => { this.now = Date.now(); this.emit(); }, Math.max(delay, 0));
    }
  }
  setLearnAhead(value: boolean) { this.learnAhead = value; this.emit(); }
  async load(moduleId?: string, createdAtCutoff: number | null = null) {
    const same = this.loadedGeneration === this.generation && this.scope === moduleId;
    if (this.scope !== moduleId || this.generation === 0) {
      this.generation++; this.scope = moduleId; this.retained = undefined;
      this.error = null; this.reviewed = 0; this.earlyUntil = null; this.undoSteps = []; this.redoSteps = [];
    }
    const token = ++this.loadGeneration;
    this.loading = true; this.emit();
    try {
      await this.writing;
      const [scheduler, [unindexed, loadedCards]] = await Promise.all([
        getScheduler(), backfillCards().then(() => Promise.all([
          call<{ id: string; name: string }[]>('unindexed_card_modules'),
          flushCardSyncs().then(() => call<StoredCard[]>('due_cards', { moduleId: moduleId ?? null, now: endOfDay(Date.now()), createdAtCutoff })),
        ])),
      ]);
      if (token !== this.loadGeneration) return;
      const previous = this.snapshot.card;
      const compatibleCards = loadedCards.map(card => card.kind === "basic" && Array.isArray(card.back) && card.back.length > 0 && card.back.every(segment => segment.type === "block" && segment.revealStep === true)
        ? { ...card, kind: "list" as const } : card);
      const cards = same && previous ? [previous, ...compatibleCards.filter(card => card.id !== previous.id)] : compatibleCards;
      this.retained = same ? previous : undefined;
      const next = same ? previous : nextInQueue(cards, Date.now(), this.learnAhead);
      if (next?.id !== previous?.id || next?.reps !== previous?.reps) { this.revealed = false; this.revealedSteps = 0; this.now = Date.now(); }
      this.scheduler = scheduler; this.queue = cards; this.loadedGeneration = this.generation;
      this.unindexed = unindexed.filter(note => !moduleId || note.id === moduleId);
    } catch (error) { if (token === this.loadGeneration) this.error = String(error); }
    finally { if (token === this.loadGeneration) { this.loading = false; this.emit(); } }
  }
  reveal = () => {
    const { card } = this.snapshot;
    if (!card || this.revealed) return;
    this.now = Date.now();
    this.revealedSteps++;
    this.revealed = card.kind !== "list" || Array.isArray(card.back) && this.revealedSteps >= card.back.length;
    this.emit();
  };
  showNow = () => { this.earlyUntil = this.snapshot.nextDueAt; this.emit(); };
  private async action(run: (mine: number) => Promise<void>) {
    if (this.pending || this.loading) return;
    this.pending = true;
    const mine = this.generation;
    // Track the entire operation, including sibling availability, before any
    // later scope load is allowed to read storage.
    const operation = (async () => {
      try { await run(mine); }
      catch (error) { if (mine === this.generation) this.error = String(error); }
      finally {
        this.pending = false;
        void queryClient.invalidateQueries({ queryKey: dueCountsKey });
        if (mine === this.generation) { this.revealed = false; this.revealedSteps = 0; this.now = Date.now(); this.earlyUntil = null; }
        this.emit();
      }
    })();
    this.writing = operation;
    this.emit();
    await operation;
  }
  rate = async (rating: Grade) => {
    const { card } = this.snapshot;
    if (!this.scheduler || !card || !this.revealed) return;
    const scheduler = this.scheduler;
    await this.action(async mine => {
      const reviewTime = Date.now();
      const result = scheduleReview(scheduler, card, rating, reviewTime, reviewTime - this.shownAt);
      await writeCards('review_card', { cardId: card.id, expectedReps: card.reps, card: result.card, log: result.log });
      if (mine !== this.generation) return;
      const queueBefore = this.queue ?? [];
      const remaining = queueBefore.filter(queued => queued.id !== card.id);
      const hasSibling = card.kind === 'basic' && remaining.some(queued => queued.kind === 'basic' && queued.moduleId === card.moduleId && queued.id === siblingOf(card.id));
      const coreCards = !hasSibling ? [] : await call<StoredCard[]>('due_cards', { moduleId: card.moduleId, now: Number.MAX_SAFE_INTEGER, createdAtCutoff: null }).catch(() => null);
      if (mine !== this.generation) return;
      const rest = coreCards ? separateSibling(remaining, card, coreCards) : remaining.filter(queued => !(card.kind === 'basic' && queued.kind === 'basic' && queued.moduleId === card.moduleId && queued.id === siblingOf(card.id)));
      const queueAfter = result.card.dueAt < endOfDay(reviewTime) ? [...rest, { ...card, ...result.card }] : rest;
      this.error = null; this.reviewed++; this.queue = queueAfter; this.retained = undefined;
      this.undoSteps.push({ before: card, result, queueBefore, queueAfter }); this.redoSteps = [];
    });
  };
  undo = async () => {
    const step = this.undoSteps[this.undoSteps.length - 1];
    if (!step) return;
    await this.action(async mine => {
      await writeCards('undo_review', { cardId: step.before.id, expectedReps: step.result.card.reps, previous: reviewedFields(step.before), previousFsrsModel: step.before.fsrsModel, reviewTime: step.result.log.reviewTime });
      if (mine !== this.generation) return;
      this.error = null; this.undoSteps.pop(); this.redoSteps.push(step); this.queue = step.queueBefore; this.retained = undefined; this.reviewed--;
    });
  };
  redo = async () => {
    const step = this.redoSteps[this.redoSteps.length - 1];
    if (!step) return;
    await this.action(async mine => {
      await writeCards('review_card', { cardId: step.before.id, expectedReps: step.before.reps, card: step.result.card, log: step.result.log });
      if (mine !== this.generation) return;
      this.error = null; this.redoSteps.pop(); this.undoSteps.push(step); this.queue = step.queueAfter; this.retained = undefined; this.reviewed++;
    });
  };
}
