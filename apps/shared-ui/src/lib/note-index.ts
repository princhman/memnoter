import { settled } from "@/lib/async-work";
import * as Y from "yjs";
import { call, isSecondaryWindow } from "@/lib/backend";
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

async function refreshStoredNote(
  moduleId: string,
  permit: WritePermit | undefined,
  kind: "search" | "cards-and-search",
) {
  for (let attempt = 0; ; attempt++) {
    assertWritable(permit);
    try {
      const doc = await loadStoredNote(moduleId);
      try {
        if (kind === "cards-and-search") {
          const { indexStoredCards } = await import("@/lib/card-backfill");
          await indexStoredCards(moduleId, doc, permit);
        }
        await indexStoredNote(moduleId, doc, permit, kind === "search" ? "background" : undefined);
      } finally { doc.destroy(); }
      return;
    } catch (error) {
      console.error(`Failed to refresh note ${moduleId} (attempt ${attempt + 1}/3):`, error);
      if (attempt === 2 || !isWriteAdmitted(permit)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

// Changes that can backfill cards share a queue with imports and sync.
export function refreshDerived(moduleId: string, admittedPermit?: WritePermit): Promise<void> {
  const previous = queue;
  const run = (permit: WritePermit) => previous.then(() => refreshStoredNote(moduleId, permit, "cards-and-search"));
  const task = admittedPermit ? run(admittedPermit) : writeOperation(run);
  pending.set(moduleId, task);
  queue = settled(task);
  void settled(task).then(() => { if (pending.get(moduleId) === task) pending.delete(moduleId); });
  return task;
}

async function backfillNotes(ids: Iterable<string>, refresh: (id: string) => Promise<void>) {
  for (const id of ids) {
    await new Promise<void>(resolve => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
      else setTimeout(resolve, 50);
    });
    if (!isWriteAdmitted()) return;
    try { await refresh(id); }
    catch (error) { console.error(`Backfill failed for note ${id}:`, error); }
  }
}

function createBackfill() {
  const cardIds = call<{ id: string }[]>("unindexed_card_modules")
    .then(notes => new Set(notes.map(note => note.id)))
    .catch(error => {
      console.error("Failed to list notes for card backfill:", error);
      return new Set<string>();
    });
  const searchIds = call<string[]>("unindexed_modules", { version: EXTRACTOR_VERSION })
    .catch(error => {
      console.error("Failed to list notes for search backfill:", error);
      return [];
    });
  const cards = cardIds.then(ids => backfillNotes(ids, refreshDerived));
  const search = Promise.all([cardIds, searchIds]).then(([cards, search]) =>
    backfillNotes(search.filter(id => !cards.has(id)), id =>
      refreshStoredNote(id, undefined, "search")));
  return { cards, all: Promise.all([cards, search]).then(() => {}) };
}

let backfill: ReturnType<typeof createBackfill> | undefined;

export function startBackfill() {
  if (isSecondaryWindow()) return Promise.resolve();
  return (backfill ??= createBackfill()).all;
}

export function backfillCards() {
  if (isSecondaryWindow()) return Promise.resolve();
  return (backfill ??= createBackfill()).cards;
}
