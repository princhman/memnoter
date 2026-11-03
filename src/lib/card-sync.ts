import { writeCards } from "@/lib/card-writes";
import { saveQueue } from "@/lib/saves";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import type { Editor } from "@tiptap/react";
import { call as invoke } from "./backend.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { blockIdOf, extractCards } from "@/lib/cards";
import type { CardSchedule } from "@/lib/flashcards";

const SYNC_DEBOUNCE_MS = 800;
const DUE_REFRESH_MS = 60_000;

const activeSyncs = new Set<() => Promise<unknown>>();
const pendingSyncs = new Set<Promise<unknown>>();

// Review must include edits still inside the editor's debounce window, even
// when unmount cleanup has already started the final write.
export async function flushCardSyncs() {
  await Promise.all([...activeSyncs].map((sync) => sync()));
  await Promise.all([...pendingSyncs]);
}

// Palette actions share the same flush/error behavior as blocked navigation.
export async function openReview(navigate: () => Promise<unknown>) {
  try {
    await flushCardSyncs();
    await navigate();
  } catch (error) {
    window.alert("Could not open review. Please retry saving flashcards first.");
    console.error("Failed to open review:", error);
  }
}

export const dueCountsKey = ["cards", "due-counts"];

// Notes open in an editor, which keeps their cards in sync itself.
const openModules = new Map<string, number>();

// Keeps a module's cards in the database in step with an editor's text: now,
// after edits settle, and when stopped. `flush` waits until the database has
// the editor's current cards, including ids renewed after a conflict.
export function startCardSync(editor: Editor, moduleId: string, onSynced: () => void) {
  let timeout: number | undefined;
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

  const sync = (): Promise<void> => {
    window.clearTimeout(timeout);
    timeout = undefined;
    if (saveQueue.isSuspended()) return Promise.resolve();
    const cards = snapshot();
    const payload = JSON.stringify(cards);
    if (payload === lastSent) return lastWrite;
    lastSent = payload;
    // Keep syncs in order so an older snapshot never lands last.
    const write = queue
      .then(() => writeCards<string[]>("sync_cards", { moduleId, cards }))
      .then((conflicts) => {
        // Blocks copied from another note get their own cards here.
        if (conflicts.length > 0 && !editor.isDestroyed) {
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
    pendingSyncs.add(write);
    queue = write.catch(() => {}).finally(() => {
      pendingSyncs.delete(write);
    });
    return write;
  };

  const schedule = () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      void sync().catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  };

  const flush = async () => {
    // Conflict repair changes the document; persist its fresh ids as well.
    do {
      await sync();
    } while (!saveQueue.isSuspended() && !editor.isDestroyed && JSON.stringify(snapshot()) !== lastSent);
  };
  activeSyncs.add(flush);
  void sync().catch(() => {});
  editor.on("update", schedule);

  const stop = () => {
    editor.off("update", schedule);
    if (timeout !== undefined) void sync().catch(() => {});
    activeSyncs.delete(flush);
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
    editor.commands.setCardSchedules(data, dataUpdatedAt);
  }, [editor, data, dataUpdatedAt]);
}

// Cards due now, split like Anki: never reviewed, in (re)learning steps, and
// graduated cards due again. Unlike Anki, a card due later today is not due
// yet; those are counted apart, split the same way.
type Split = { new: number; learning: number; review: number };
export type CardCounts = Split & { laterToday?: Split };

const none = (): Required<CardCounts> => ({
  new: 0, learning: 0, review: 0, laterToday: { new: 0, learning: 0, review: 0 },
});

// The next local midnight.
export function endOfDay(now: number) {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return end.getTime();
}

export function useDueCounts() {
  const { data } = useQuery({
    queryKey: dueCountsKey,
    queryFn: () => {
      const now = Date.now();
      return invoke<({ moduleId: string; count: number; laterNew: number;
        laterLearning: number; laterReview: number } & Split)[]>(
        "due_counts",
        { now, dayEnd: endOfDay(now) },
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

// Desktop navigation waits for card ID repair before unmounting the editor.
export function CardNavigationGuard({ editor, ready }: { editor: Editor | null; ready: boolean }) {
  // Keep the editor alive until copied ids have been repaired and resynced.
  useBlocker({
    disabled: !editor || !ready,
    enableBeforeUnload: false,
    shouldBlockFn: async () => {
      try {
        await flushCardSyncs();
        return false;
      } catch {
        window.alert("Could not save flashcards. Please try leaving the note again.");
        return true;
      }
    },
  });

  return null;
}
