import { createStore } from "@tanstack/react-store";
import { queryClient } from "@/lib/query-client";
import { flushSaves, saveQueue } from "@/lib/saves";
import { flushCardSyncs } from "@/lib/card-sync";

let exclusive = false;
const listeners = new Set<(blocked: boolean) => void>();
type ImageWork = {
  run: () => Promise<unknown>;
  pending?: Promise<unknown>;
  error?: string;
  retry?: boolean;
  dispose?: () => void;
};
const images = new Set<ImageWork>();
export const imageStatusStore = createStore({ errors: [] as string[] });
const publishImages = () => imageStatusStore.setState(() => ({
  errors: [...images].flatMap(work => work.error ? [work.error] : []),
}));

export function watchWriteAdmission(listener: (blocked: boolean) => void) {
  listeners.add(listener);
  listener(exclusive);
  return () => { listeners.delete(listener); };
}

async function runImage(work: ImageWork) {
  const pending = Promise.resolve().then(work.run);
  work.pending = pending;
  try {
    const result = await pending;
    images.delete(work);
    work.dispose?.();
    return result;
  } catch (error) {
    work.error = `An image could not be saved: ${error instanceof Error ? error.message : String(error)}${work.retry ? "" : ". Keep editing to reapply it, then explicitly discard this failed operation."}`;
    throw error;
  } finally {
    work.pending = undefined;
    publishImages();
  }
}

// A retry callback must resume its own progress, never replay completed inserts.
// Without that guarantee the failure remains actionable until explicit discard.
export async function imageOperation<T>(operation: () => Promise<T>, options: {
  retry?: boolean; dispose?: () => void;
} = {}): Promise<T> {
  if (exclusive || saveQueue.isSuspended()) throw new Error("Image writes are suspended.");
  const work: ImageWork = { run: operation, ...options };
  images.add(work);
  return await runImage(work) as T;
}

// Upload receipts and completed insertions survive transport failures separately.
export function imageFilesOperation<File, Saved>(files: readonly File[], handlers: {
  checkTarget: () => void;
  upload: (file: File) => Promise<Saved>;
  insert: (saved: Saved, file: File) => void;
  dispose: () => void;
}) {
  let next = 0;
  let receipt: { value: Saved } | undefined;
  return imageOperation(async () => {
    while (next < files.length) {
      handlers.checkTarget();
      receipt ??= { value: await handlers.upload(files[next]) };
      handlers.checkTarget();
      handlers.insert(receipt.value, files[next]);
      next++;
      receipt = undefined;
    }
  }, { retry: true, dispose: handlers.dispose });
}

export function discardFailedImages() {
  if (exclusive) throw new Error("Another database operation is in progress.");
  for (const work of images) if (work.error && !work.pending) {
    images.delete(work);
    work.dispose?.();
  }
  publishImages();
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
  { discard = false, excludedMutation, retain = false, retryImages = false }: {
    discard?: boolean; excludedMutation?: string; retain?: boolean; retryImages?: boolean;
  } = {},
): Promise<T> {
  if (exclusive || saveQueue.isSuspended()) throw new Error("Another database operation is in progress. Please retry.");
  exclusive = true;
  listeners.forEach(listener => listener(true));
  let suspended = false;
  let completed = false;
  try {
    // Snapshot admission is closed; retries retain the same operation identity.
    const work = [...images];
    await Promise.allSettled(work.flatMap(item => item.pending ? [item.pending] : []));
    if (!discard && retryImages) {
      await Promise.allSettled(work.filter(item => images.has(item) && item.error && item.retry)
        .map(item => runImage(item)));
    }
    if (!discard && [...images].some(item => item.error)) {
      throw new Error(imageStatusStore.state.errors.join("\n"));
    }
    if (!discard) {
      await flushCardSyncs();
      if (!await flushSaves(3_000)) throw new Error("Pending edits could not be saved. Please retry saving first.");
    }
    await saveQueue.suspend();
    suspended = true;
    await drainMutations(excludedMutation);
    const result = await action();
    if (discard) {
      for (const item of images) item.dispose?.();
      images.clear();
      publishImages();
    }
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
