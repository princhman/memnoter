import { writeCards } from "@/lib/card-writes";
import { saveQueue } from "@/lib/saves";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import type { Editor } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
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
    extractCards(editor.state.doc).map(({ id, kind, front, back }) => ({
      id,
      kind,
      front,
      back,
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

// Due cards, split like Anki: never reviewed, in (re)learning steps, and
// graduated cards due again.
export type CardCounts = { new: number; learning: number; review: number };

const NO_CARDS: CardCounts = { new: 0, learning: 0, review: 0 };

export function useDueCounts() {
  const { data } = useQuery({
    queryKey: dueCountsKey,
    queryFn: () =>
      invoke<({ moduleId: string; count: number } & CardCounts)[]>("due_counts", {
        now: Date.now(),
      }),
    // Cards fall due as time passes, not only after edits.
    refetchInterval: DUE_REFRESH_MS,
  });
  const byModule = new Map<string, CardCounts>(
    data?.map(({ moduleId, new: fresh, learning, review }) => [
      moduleId,
      { new: fresh, learning, review },
    ]),
  );
  const total = { ...NO_CARDS };
  for (const counts of byModule.values()) {
    total.new += counts.new;
    total.learning += counts.learning;
    total.review += counts.review;
  }
  return {
    total,
    forModule: (moduleId: string) => byModule.get(moduleId) ?? NO_CARDS,
  };
}
