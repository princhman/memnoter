import { settled } from "@/lib/async-work";
import * as Y from "yjs";
import { call } from "@/lib/backend";
import { applySavedContent, reconcileContent, type GetContentResponse } from "@/lib/content";
import { applyPendingSaves, saveQueue } from "@/lib/saves";
import { indexStoredNote } from "@/lib/search-index";
import { EXTRACTOR_VERSION } from "@/lib/search-text";
import { assertWritable, isWriteAdmitted, registerFlusher, writeOperation, type WritePermit } from "@/lib/write-lifecycle";

export async function loadStoredNote(moduleId: string) {
  const pending = saveQueue.pending(moduleId);
  const content = await call<GetContentResponse>("get_content", { moduleId });
  const doc = new Y.Doc();
  try {
    applySavedContent(doc, reconcileContent(moduleId, content));
    applyPendingSaves(doc, pending);
    return doc;
  } catch (error) { doc.destroy(); throw error; }
}

let queue = Promise.resolve();
const pending = new Map<string, Promise<void>>();
registerFlusher("stored-notes", async () => {
  await Promise.all([...pending.values()]);
});

// All closed-note changes share order, pacing, and three attempts. Failures
// remain visible to callers and logs, rather than silently retrying forever.
export function refreshDerived(moduleId: string, admittedPermit?: WritePermit): Promise<void> {
  const previous = queue;
  const run = (permit: WritePermit) => previous.then(async () => {
    for (let attempt = 0; ; attempt++) {
      assertWritable(permit);
      try {
        const doc = await loadStoredNote(moduleId);
        try {
          const { indexStoredCards } = await import("@/lib/card-backfill");
          await indexStoredCards(moduleId, doc, permit);
          await indexStoredNote(moduleId, doc, permit);
        } finally { doc.destroy(); }
        return;
      } catch (error) {
        console.error(`Failed to refresh note ${moduleId} (attempt ${attempt + 1}/3):`, error);
        if (attempt === 2 || !isWriteAdmitted(permit)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  });
  const task = admittedPermit ? run(admittedPermit) : writeOperation(run);
  pending.set(moduleId, task);
  queue = settled(task);
  void settled(task).then(() => { if (pending.get(moduleId) === task) pending.delete(moduleId); });
  return task;
}

let backfill: Promise<void> | undefined;
export function startBackfill() {
  backfill ??= (async () => {
    const [cards, search] = await Promise.allSettled([
      call<{ id: string }[]>("unindexed_card_modules"),
      call<string[]>("unindexed_modules", { version: EXTRACTOR_VERSION }),
    ]);
    if (cards.status === "rejected") console.error("Failed to list notes for card backfill:", cards.reason);
    if (search.status === "rejected") console.error("Failed to list notes for search backfill:", search.reason);
    const ids = new Set([
      ...(cards.status === "fulfilled" ? cards.value.map(note => note.id) : []),
      ...(search.status === "fulfilled" ? search.value : []),
    ]);
    for (const id of ids) {
      await new Promise<void>(resolve => {
        if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
        else setTimeout(resolve, 50);
      });
      if (!isWriteAdmitted()) return;
      try { await refreshDerived(id); }
      catch (error) { console.error(`Backfill failed for note ${id}:`, error); }
    }
  })().catch(error => { console.error("Failed to start note backfill:", error); });
  return backfill;
}
