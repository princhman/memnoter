import { writeCards } from "@/lib/card-writes";
import { saveQueue } from "@/lib/saves";
import { useBlocker } from "@tanstack/react-router";
import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { blockIdOf, extractCards } from "@/lib/cards";

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

// Keeps the module's cards in the database in step with its text. Syncs once
// the note has loaded (cards written before ids existed get them then), after
// edits settle, and when the note closes.
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

  useEffect(() => {
    if (!editor || !ready) return;
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
          void queryClient.invalidateQueries({ queryKey: dueCountsKey });
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
    return () => {
      editor.off("update", schedule);
      if (timeout !== undefined) void sync().catch(() => {});
      activeSyncs.delete(flush);
    };
  }, [editor, moduleId, ready, queryClient]);
}

export function useDueCounts() {
  const { data } = useQuery({
    queryKey: dueCountsKey,
    queryFn: () =>
      invoke<{ moduleId: string; count: number }[]>("due_counts", { now: Date.now() }),
    // Cards fall due as time passes, not only after edits.
    refetchInterval: DUE_REFRESH_MS,
  });
  const byModule = new Map(data?.map(({ moduleId, count }) => [moduleId, count]));
  const total = data?.reduce((sum, { count }) => sum + count, 0) ?? 0;
  return { byModule, total };
}
