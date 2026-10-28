import { queryClient } from "@/lib/query-client";
import { flushSaves, saveQueue } from "@/lib/saves";
import { flushCardSyncs } from "@/lib/card-sync";

let exclusive = false;
const listeners = new Set<(blocked: boolean) => void>();
const images = new Set<Promise<unknown>>();

export function watchWriteAdmission(listener: (blocked: boolean) => void) {
  listeners.add(listener);
  listener(exclusive);
  return () => { listeners.delete(listener); };
}

// Owns the complete continuation, not just the upload mutation receipt.
export async function imageOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (exclusive || saveQueue.isSuspended()) throw new Error("Image writes are suspended.");
  const pending = operation();
  images.add(pending);
  try { return await pending; } finally { images.delete(pending); }
}

async function drainMutations(excluded?: string) {
  const pending = () => queryClient.isMutating({
    predicate: mutation => mutation.options.mutationKey?.[0] !== excluded,
  }) > 0;
  if (!pending()) return;
  await new Promise<void>(resolve => {
    const stop = queryClient.getMutationCache().subscribe(() => {
      if (!pending()) { stop(); resolve(); }
    });
    if (!pending()) { stop(); resolve(); }
  });
}

// Reject overlaps: only this owner may resume its suspension. Keep admission
// closed while draining, but leave the queue running until every edit is saved.
export async function exclusiveWrite<T>(
  action: () => Promise<T>,
  { discard = false, excludedMutation, retain = false }: {
    discard?: boolean; excludedMutation?: string; retain?: boolean;
  } = {},
): Promise<T> {
  if (exclusive || saveQueue.isSuspended()) throw new Error("Another database operation is in progress. Please retry.");
  exclusive = true;
  listeners.forEach(listener => listener(true));
  let suspended = false;
  let completed = false;
  try {
    const results = await Promise.allSettled([...images]);
    if (!discard && results.some(result => result.status === "rejected")) {
      throw new Error("An image could not be saved. Please retry or quit without saving.");
    }
    if (!discard) {
      await flushCardSyncs();
      if (!await flushSaves(3_000)) throw new Error("Pending edits could not be saved. Please retry saving first.");
    }
    await saveQueue.suspend();
    suspended = true;
    await drainMutations(excludedMutation);
    const result = await action();
    completed = true;
    return result;
  } finally {
    if (!completed || !retain) {
      if (suspended) saveQueue.resume();
      exclusive = false;
      listeners.forEach(listener => listener(false));
    }
  }
}
