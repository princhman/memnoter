import { isSchemaReadOnly } from "./guarded-collaboration";
import { settled } from "@/lib/async-work";
import { writeCards } from "@/lib/card-writes";
import { isWriteAdmitted, registerFlusher, type WritePermit } from "@/lib/write-lifecycle";
import { createEditorWriteSync } from "@/lib/editor-write-sync";
import { startOfDay, endOfDay, subscribeDay } from "@/lib/day-clock";
import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/react";
import { call as invoke } from "./backend.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { blockIdOf, extractCards } from "@/lib/cards";
import type { CardSchedule } from "@/lib/flashcards";

import { appStore } from "./store.ts";
import { useSelector } from "@tanstack/react-store";

const SYNC_DEBOUNCE_MS = 800;
const DUE_REFRESH_MS = 60_000;

const editorSync = createEditorWriteSync(SYNC_DEBOUNCE_MS);
export const flushCardSyncs = editorSync.flush;
registerFlusher("cards", flushCardSyncs);

export const dueCountsKey = ["cards", "due-counts"];
const currentDay = () => startOfDay(Date.now());
const noDay = () => null;
const subscribeNoDay = () => () => {};

export function useCreatedAtCutoff() {
  const enabled = useSelector(appStore, (state) => state.skipCardsCreatedToday);
  return useSyncExternalStore(enabled ? subscribeDay : subscribeNoDay, enabled ? currentDay : noDay);
}

// Notes open in an editor, which keeps their cards in sync itself.
const openModules = new Map<string, number>();

// Keeps a module's cards in the database in step with an editor's text: now,
// after edits settle, and when stopped. `flush` waits until the database has
// the editor's current cards, including ids renewed after a conflict.
export function startCardSync(editor: Editor, moduleId: string, onSynced: () => void, admittedPermit?: WritePermit) {
  let lastSent: string | undefined;
  let queue = Promise.resolve();
  let lastWrite = queue;

  const snapshot = () =>
    extractCards(editor.state.doc).map(({ id, kind, front, back, section }) => ({
      id,
      kind,
      front,
      back,
      section,
    }));

  const sync = (permit: WritePermit | undefined = admittedPermit): Promise<void> => {
    debounce.cancel();
    if (!isWriteAdmitted(permit) || isSchemaReadOnly(editor)) return Promise.resolve();
    const cards = snapshot();
    const payload = JSON.stringify(cards);
    if (payload === lastSent) return lastWrite;
    lastSent = payload;
    // Keep syncs in order so an older snapshot never lands last.
    const write = queue
      .then(() => isSchemaReadOnly(editor) ? [] : writeCards<string[]>("sync_cards", { moduleId, cards }, permit))
      .then((conflicts) => {
        // Blocks copied from another note get their own cards here.
        if (conflicts.length > 0 && !editor.isDestroyed && !isSchemaReadOnly(editor)) {
          editor.commands.renewCardIds(conflicts.map(blockIdOf));
        }
        onSynced();
      })
      .catch((error) => {
        lastSent = undefined;
        console.error("Failed to sync flashcards:", error);
        throw error;
      });
    lastWrite = write;
    editorSync.track(write);
    queue = settled(write);
    return write;
  };

  const flush = async (permit?: WritePermit) => {
    do { await sync(permit); }
    while (isWriteAdmitted(permit) && !editor.isDestroyed && !isSchemaReadOnly(editor) && JSON.stringify(snapshot()) !== lastSent);
  };
  const debounce = editorSync.attach(flush);
  const schedule = debounce.schedule;
  void settled(sync());
  editor.on("update", schedule);

  const stop = () => {
    editor.off("update", schedule);
    debounce.stop();
  };
  return { flush, stop };
}

// Syncs once the note has loaded (cards written before ids existed get them
// then), after edits settle, and when the note closes.
export function useCardSync(editor: Editor | null, moduleId: string, ready: boolean) {
  const queryClient = useQueryClient();
  // Before loading starts, so a background check never races this editor.
  useLayoutEffect(() => {
    openModules.set(moduleId, (openModules.get(moduleId) ?? 0) + 1);
    return () => {
      const count = openModules.get(moduleId)! - 1;
      if (count === 0) openModules.delete(moduleId);
      else openModules.set(moduleId, count);
    };
  }, [moduleId]);

  useEffect(() => {
    if (!editor || !ready) return;
    return startCardSync(editor, moduleId, () => {
      void queryClient.invalidateQueries({ queryKey: dueCountsKey });
    }).stop;
  }, [editor, moduleId, ready, queryClient]);
}

export function isModuleOpen(moduleId: string) {
  return openModules.has(moduleId);
}

// When the module's cards are due and were last reviewed, shown beside each
// card in the editor. Under the due counts' key, so every change that
// refreshes the counts (syncs, grades, deletions) refreshes these too.
export function useCardSchedules(editor: Editor | null, moduleId: string, ready: boolean) {
  const cutoff = useCreatedAtCutoff();
  const { data, dataUpdatedAt } = useQuery({
    queryKey: [...dueCountsKey, "schedules", moduleId],
    queryFn: () => invoke<CardSchedule[]>("card_schedules", { moduleId }),
    enabled: ready,
    // Cards fall due as time passes.
    refetchInterval: DUE_REFRESH_MS,
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed || !data) return;
    // As of the fetch, which repeats every minute.
    editor.commands.setCardSchedules(data.map((card) =>
      cutoff !== null && card.state === 0 && card.lastReviewAt === null && card.createdAt >= cutoff
        ? { ...card, dueAt: Math.max(card.dueAt, endOfDay(Date.now())) } : card), dataUpdatedAt);
  }, [editor, data, dataUpdatedAt, cutoff]);
}

// Cards due now, split like Anki: never reviewed, in (re)learning steps, and
// graduated cards due again. Unlike Anki, a card due later today is not due
// yet; those are counted apart, split the same way.
type Split = { new: number; learning: number; review: number };
export type CardCounts = Split & { laterToday?: Split };

const none = (): Required<CardCounts> => ({
  new: 0, learning: 0, review: 0, laterToday: { new: 0, learning: 0, review: 0 },
});

export function useDueCounts() {
  const cutoff = useCreatedAtCutoff();
  const { data } = useQuery({
    queryKey: [...dueCountsKey, cutoff],
    placeholderData: (previous) => previous,
    queryFn: () => {
      const now = Date.now();
      return invoke<({ moduleId: string; count: number; laterNew: number;
        laterLearning: number; laterReview: number } & Split)[]>(
        "due_counts",
        { now, dayEnd: endOfDay(now), createdAtCutoff: cutoff },
      );
    },
    // Cards fall due as time passes, not only after edits.
    refetchInterval: DUE_REFRESH_MS,
  });
  const byModule = new Map<string, Required<CardCounts>>(
    data?.map((row) => [
      row.moduleId,
      {
        new: row.new,
        learning: row.learning,
        review: row.review,
        laterToday: { new: row.laterNew, learning: row.laterLearning, review: row.laterReview },
      },
    ]),
  );
  const total = none();
  for (const counts of byModule.values()) {
    for (const key of ["new", "learning", "review"] as const) {
      total[key] += counts[key];
      total.laterToday[key] += counts.laterToday[key];
    }
  }
  return {
    total,
    forModule: (moduleId: string) => byModule.get(moduleId) ?? none(),
  };
}
